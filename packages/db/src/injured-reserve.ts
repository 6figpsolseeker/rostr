import {
  buildRosterShape,
  countedRosterSize,
  NFL,
  refuseIrPlacement,
  reservedByTrades,
} from "@rostr/core";
import type { IrPlacementRefusal } from "@rostr/core";
import { getLeagueRules } from "./leagues.js";
import type { SqlClient } from "./client.js";
import { withTransaction } from "./transaction.js";
import { heldForCapacity } from "./roster-capacity.js";
import { committedTradeMoves } from "./trades.js";

/**
 * Moving a player on and off injured reserve.
 *
 * The rules have carried `roster.irSlots` since the schema was written and
 * nothing read it — see `0038` and `@rostr/core`'s `injured-reserve.ts` for why
 * that is the `botsAllowed` defect rather than a missing nicety.
 *
 * **Neither direction releases anybody.** IR is where a player sits, not whether
 * he is owned: `roster_entries.released_at` is untouched by both, so a stashed
 * player is still on the roster, still un-addable by anyone else, and still
 * subject to every ownership check. What changes is whether he counts against
 * the limit.
 */
export class IrError extends Error {
  constructor(
    message: string,
    readonly code:
      | IrPlacementRefusal
      | "LEAGUE_NOT_FOUND"
      | "NOT_ON_IR"
      | "GAME_STARTED"
      /**
       * Bringing him back would put the roster over the limit.
       *
       * Named as `acceptTrade` names the same fact, and deliberately not
       * `ROSTER_FULL`: that code's sentence is "drop someone first", which is
       * the instruction issue #273 documents as misleading in exactly this
       * corner — dropping the injured man frees an IR slot, not a roster slot.
       *
       * Not added to `IrPlacementRefusal`. That union is the vocabulary
       * `refuseIrPlacement` speaks about *placing* a player, and it would owe a
       * `REFUSALS` message for a refusal it can never produce.
       */
      | "ROSTER_WOULD_OVERFLOW"
      /** A slot is being held for a trade this team accepted. */
      | "SLOT_HELD_FOR_TRADE",
  ) {
    super(message);
    this.name = "IrError";
  }
}

const REFUSALS: Record<IrPlacementRefusal, string> = {
  NOT_INJURED:
    "Injured reserve holds only players carrying an official out designation. " +
    "This one is listed as available.",
  IR_FULL: "Every injured reserve slot is taken.",
  NOT_ON_ROSTER: "That player is not on this roster.",
};

interface Held {
  player_id: string;
  on_ir: boolean;
  designation: string | null;
  kickoff_at: string | null;
}

/**
 * The roster as the IR rule sees it, locked for the length of the transaction.
 *
 * `FOR UPDATE OF r` locks the roster rows and not the joined `players` rows —
 * the designation is read, never written here, and locking a shared player row
 * would serialise every team in the league behind one manager's IR move.
 */
async function heldRoster(
  tx: SqlClient,
  teamId: string,
  season: number,
  week: number,
): Promise<Held[]> {
  // Joined the way `loadKickoffs` joins — on `sport_id` and a supplied season,
  // because `players` carries a sport rather than a season. Deriving it here a
  // second way is how the two would come to disagree about which game a player
  // is in.
  return tx.query<Held>(
    `SELECT r.player_id, r.on_ir, p.injury_designation AS designation,
            g.kickoff_at
       FROM roster_entries r
       JOIN players p ON p.id = r.player_id
       LEFT JOIN games g
         ON g.sport_id = p.sport_id
        AND g.season = $2
        AND g.week = $3
        AND (g.home_team_ref = p.team_ref OR g.away_team_ref = p.team_ref)
      WHERE r.team_id = $1 AND r.released_at IS NULL
      FOR UPDATE OF r`,
    [teamId, season, week],
  );
}

/**
 * Stash an injured player.
 *
 * **Refused once his game has kicked off**, for the same reason `RULES.md` §6
 * refuses an add or a drop then: moving a player to IR mid-game changes what
 * counts against the roster while the thing being reacted to is happening. The
 * lineup lock already stops him being started or benched; this stops the same
 * reaction taking a different route.
 */
export async function moveToIr(
  db: SqlClient,
  input: {
    readonly leagueId: string;
    readonly teamId: string;
    readonly playerId: string;
    readonly week: number;
    readonly now: Date;
  },
): Promise<{ playerId: string }> {
  const stored = await getLeagueRules(db, input.leagueId);
  if (!stored) throw new IrError("League has no rules", "LEAGUE_NOT_FOUND");

  const shape = buildRosterShape(stored.rules.roster, NFL);

  return withTransaction(db, async (tx) => {
    const held = await heldRoster(tx, input.teamId, stored.rules.seasonYear, input.week);

    const refusal = refuseIrPlacement({
      roster: held.map((row) => ({
        playerId: row.player_id,
        onIr: row.on_ir,
        injuryDesignation: row.designation,
      })),
      playerId: input.playerId,
      irSlots: shape.irSlots,
    });
    if (refusal) throw new IrError(REFUSALS[refusal], refusal);

    const player = held.find((row) => row.player_id === input.playerId);
    if (player?.kickoff_at && new Date(player.kickoff_at) <= input.now) {
      throw new IrError(
        "His game has kicked off. Injured reserve is available again next week.",
        "GAME_STARTED",
      );
    }

    await tx.query(
      "UPDATE roster_entries SET on_ir = true WHERE team_id = $1 AND player_id = $2 AND released_at IS NULL",
      [input.teamId, input.playerId],
    );

    return { playerId: input.playerId };
  });
}

/**
 * Bring a player back.
 *
 * **A recovered player is never refused**, and that is the important
 * asymmetry. A team whose stashed player recovered is already over the counted
 * limit — the exemption evaporated the moment his designation cleared — so
 * refusing to activate him would trap the roster in the illegal state rather
 * than let the manager resolve it. Activation is the fix, not the offence.
 *
 * **A player who is still genuinely hurt is a different case, and this used to
 * treat them alike.** He is not counting, activation is `+1`, and nothing is
 * trapped by refusing: leaving him on injured reserve is a legal, stable state
 * that costs the team nothing. So a team at the limit could bring him back and
 * sit at `totalSlots + 1` — a second route past the line #250 drew, and the
 * one the docstring above was accidentally defending. Issue #272.
 *
 * ## The question this asks, and the one it refuses to ask
 *
 * Not "is this player exempt". That has no answer. `irExemptCount` caps
 * exemptions at `irSlots` **by count, not by identity**, so a team holding
 * three genuinely-injured players with two slots has two exemptions and no way
 * to say which two — and any tie-break invented here (insertion order, id,
 * acquisition date) would be a rule that exists nowhere else in the product.
 *
 * The well-formed question is what the move *costs*: recompute the counted size
 * with this player's flag flipped and compare. The algebra is
 * `capped(g, s) - capped(g - 1, s)`, which is **1 when `g <= s` and 0 when
 * `g > s`** — so the third stashed player of three, with two slots, activates
 * for free, because one of the three was already counting. A predicate keyed on
 * `onIr && isIrEligible` refuses all three of them, every one wrongly.
 *
 * ## Why this cannot trap anybody
 *
 * It refuses only when the move *raises* the count and lands over the limit,
 * which means the roster it refuses from is `after - 1 <= totalSlots` —
 * legal. A refusal therefore never leaves a manager in an illegal state, which
 * is what separates it from the case the docstring above rightly protects.
 *
 * Still no kickoff check. Coming off IR only ever adds to what counts, so it
 * cannot be used to dodge anything mid-game, and the lineup lock still decides
 * whether he can actually be started.
 */
export async function activateFromIr(
  db: SqlClient,
  input: {
    readonly leagueId: string;
    readonly teamId: string;
    readonly playerId: string;
  },
): Promise<{ playerId: string }> {
  const stored = await getLeagueRules(db, input.leagueId);
  if (!stored) throw new IrError("League has no rules", "LEAGUE_NOT_FOUND");
  const shape = buildRosterShape(stored.rules.roster, NFL);

  return withTransaction(db, async (tx) => {
    /*
      Locked, because this reads every row of the roster and then writes one of
      them. Two managers cannot do this at once, but one manager with two tabs
      can: both reads see a roster where only their own flip is pending, both
      compute the same room, and the two `UPDATE`s touch different rows so
      nothing conflicts. Textbook write skew, and `FOR UPDATE` is what stops it.
    */
    const roster = await heldForCapacity(tx, input.teamId, { lock: true });

    if (!roster.some((entry) => entry.playerId === input.playerId && entry.onIr)) {
      throw new IrError("That player is not on injured reserve.", "NOT_ON_IR");
    }

    // The same roster with this one move made. Rows are unchanged — activation
    // releases nobody — so only the exemption count can move.
    const activated = roster.map((entry) =>
      entry.playerId === input.playerId ? { ...entry, onIr: false } : entry,
    );

    const before = countedRosterSize(roster, shape.irSlots);
    const after = countedRosterSize(activated, shape.irSlots);

    /*
      Room already spoken for by accepted trades, counted against the roster
      this move would leave behind.

      Computed on `activated` rather than on `roster`: a stashed player who is
      also on his way out in a trade frees no roster slot while he is exempt,
      but does once he is not, and measuring before the flip would count him
      twice and refuse a move that fits.

      Cheap to skip when the move is free — `after > before` is checked first,
      so the recovered player never reaches this query at all.
    */
    if (after > before) {
      const moves = await committedTradeMoves(tx, input.leagueId);
      const reserved = reservedByTrades(
        activated,
        moves.get(input.teamId) ?? [],
        shape.irSlots,
      );

      if (after + reserved > shape.totalSlots) {
        // Which count crossed the line decides what he is told, the same way
        // `addFreeAgent` decides it. "Drop someone" is the wrong instruction
        // when the room exists and a trade is holding it.
        const spokenFor = after <= shape.totalSlots;
        throw new IrError(
          spokenFor
            ? "A roster spot is being held for a trade you accepted, so there is no room to " +
                "bring him back until that trade executes or is vetoed. He is still listed out, " +
                "so injured reserve holds his place until then."
            : `Bringing him back would leave you holding ${after} players and the limit is ` +
                `${shape.totalSlots}. He is still listed out, so injured reserve is his for as ` +
                `long as he needs it — release one of your active players first if you want him ` +
                `back now.`,
          spokenFor ? "SLOT_HELD_FOR_TRADE" : "ROSTER_WOULD_OVERFLOW",
        );
      }
    }

    await tx.query(
      `UPDATE roster_entries SET on_ir = false
        WHERE team_id = $1 AND player_id = $2 AND released_at IS NULL AND on_ir`,
      [input.teamId, input.playerId],
    );

    return { playerId: input.playerId };
  });
}
