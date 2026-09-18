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
import { heldForCapacity, lockRosterCapacity } from "./roster-capacity.js";
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
      | "SLOT_HELD_FOR_TRADE"
      /**
       * The league is not in a state where injured reserve may be used.
       *
       * Same code the waiver and trade paths raise for the same fact, so a
       * caller that already handles a closed market handles this too.
       */
      | "LEAGUE_NOT_IN_SEASON",
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

/**
 * Whether the league is in a state where injured reserve may be used, and why
 * not when it is not.
 *
 * **Placement and activation do not get the same answer, and the asymmetry is
 * the decision.** Owner's ruling, 2026-09-18, issue #311.
 *
 * Both are open in `IN_SEASON` and `PLAYOFFS`, and shut in `FORMING`, `SETTLED`
 * and `DISSOLVED` — before a roster exists, and after it is final. That half is
 * the same rule every other member-facing roster path already applies.
 *
 * `DRAFTING` is where they part:
 *
 * - **Placement is refused.** The draft decides roster legality in memory
 *   against `state.picks` and never reads `roster_entries`, so an IR flag set
 *   mid-draft is invisible to it. Stashing lowers a team's counted size, which
 *   is precisely the direction that lets the engine believe a team has room it
 *   does not, and a pick can then land it over the limit its members signed.
 * - **Activation is allowed.** Not because it lowers anything — it *raises*
 *   counted size, and a recovered player is already counting before it runs.
 *   It is allowed because the whole injured-reserve design turns on never
 *   forcing anyone off a roster: activation is the only way a player leaves
 *   that slot without being dropped, and it frees the slot for whoever is hurt
 *   next. Refusing it is how a recoverable state becomes a permanent one — the
 *   argument `cancelClaim` is deliberately left ungated for.
 *
 * So the narrow rule is "you may put the parked player back, you may not park a
 * new one", which is the shape that cannot make a draft worse and cannot trap a
 * team.
 */
export type IrMove = "PLACE" | "ACTIVATE";

function irClosedReason(state: string, move: IrMove): string | null {
  if (state === "IN_SEASON" || state === "PLAYOFFS") return null;

  if (state === "DRAFTING") {
    return move === "ACTIVATE"
      ? null
      : "Your draft is still running, and it counts every pick you have made rather " +
          "than reading your roster — so a player parked now would not be counted. " +
          "Injured reserve opens when the last pick is in.";
  }

  if (state === "FORMING") {
    return "This league has not drafted yet, so there is no roster to move anyone on or off.";
  }

  return "This league's season is over, so its rosters are final.";
}

/**
 * The same rule, as a refusal.
 *
 * Read inside the transaction and under the league lock, never before it — the
 * reason `addFreeAgent` gives for the same read: `recordPick` sets `IN_SEASON`
 * in the transaction that commits the final pick, and the lock conflicts with
 * that write, so this either sees `DRAFTING` and refuses or sees `IN_SEASON`
 * after the last pick has landed. There is no window between them.
 */
function refuseUnlessIrIsOpen(state: string, move: IrMove): void {
  const reason = irClosedReason(state, move);
  if (reason) throw new IrError(reason, "LEAGUE_NOT_IN_SEASON");
}

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
    /*
      The league, shared, and taken purely to be mutually exclusive with
      `processWaivers`, and the row the state is read from.

      Both jobs, one statement. The lock is why the read can be trusted:
      `recordPick` sets `IN_SEASON` in the transaction that commits the final
      pick, and `FOR SHARE` conflicts with that write, so this either sees
      `DRAFTING` and refuses or sees `IN_SEASON` after the last pick has landed.
      There is no window between them. Read on the bare client instead and the
      answer is about a moment that has already passed — which `waivers.ts`
      records having shipped here once.

      This block used to say the state was **deliberately not read**, because
      when the lock landed (#277) the rules question was still open. The owner
      settled it on 2026-09-18 and #311 is closed; the sentence outlived what it
      described by one commit.

      Every path that *decides capacity against `roster_entries`* now holds this
      row, and `recordPick` remains the exception: the draft decides capacity in
      memory against its own picks and takes no league lock. What keeps it apart
      from these two is the state gate below rather than any lock — which is why
      #311's answer had to be a gate.

      `setLineup` and `submitClaim` are member-facing and take no league lock
      either, deliberately: neither changes a roster, so neither can move a
      counted size.

      Why the lock is needed anyway: the waiver run resolves against one
      league-wide snapshot, and the exemption it reads is a fact about IR flags.
      A placement committing mid-run makes that snapshot wrong by one in the
      direction that **fails a legitimate claim** — this lowers counted size, so
      it can only ever make a team look fuller than it is, never emptier. The
      opposite half of that sentence belongs to `activateFromIr`, not here.

      No capacity key: a move that can only lower the count cannot carry a team
      over its limit, and the key exists for the writers that raise it.
    */
    const [league] = await tx.query<{ state: string }>(
      "SELECT state FROM leagues WHERE id = $1 FOR SHARE",
      [input.leagueId],
    );
    if (!league) throw new IrError("League has no rules", "LEAGUE_NOT_FOUND");
    refuseUnlessIrIsOpen(league.state, "PLACE");

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
      The capacity key, first — and without it the comment below is wrong about
      the case that matters. Issue #277.

      `FOR UPDATE OF r` does stop two activations, which is the write skew it
      was written for. It cannot stop a concurrent `addFreeAgent`, because that
      one's contribution is an **insert**: a row that does not yet exist is a
      phantom, and no row lock under READ COMMITTED blocks one. Both read twelve
      rows, both find room, and the team lands one over.

      That case is also why the key is on the team's identity rather than on its
      rows — two writers raising one team's counted size have to contend on
      something whatever rows they happen to touch.
    */
    await lockRosterCapacity(tx, input.teamId);

    /*
      The league, shared, and taken purely to be mutually exclusive with
      `processWaivers`, and the row the state is read from.

      Both jobs, one statement. The lock is why the read can be trusted:
      `recordPick` sets `IN_SEASON` in the transaction that commits the final
      pick, and `FOR SHARE` conflicts with that write, so this either sees
      `DRAFTING` and refuses or sees `IN_SEASON` after the last pick has landed.
      There is no window between them. Read on the bare client instead and the
      answer is about a moment that has already passed — which `waivers.ts`
      records having shipped here once.

      This block used to say the state was **deliberately not read**, because
      when the lock landed (#277) the rules question was still open. The owner
      settled it on 2026-09-18 and #311 is closed; the sentence outlived what it
      described by one commit.

      Every path that *decides capacity against `roster_entries`* now holds this
      row, and `recordPick` remains the exception: the draft decides capacity in
      memory against its own picks and takes no league lock. What keeps it apart
      from these two is the state gate below rather than any lock — which is why
      #311's answer had to be a gate.

      `setLineup` and `submitClaim` are member-facing and take no league lock
      either, deliberately: neither changes a roster, so neither can move a
      counted size.

      Why the lock is needed anyway: the waiver run resolves against one
      league-wide snapshot, and the exemption it reads is a fact about IR flags.
      An activation committing mid-run makes that snapshot wrong by one in the
      direction that **awards into a slot that is no longer free** — this raises
      counted size. The mirror half belongs to `moveToIr`.

      After the capacity key, never before it: a transaction waiting on the key
      must hold nothing, or the key can close a deadlock cycle. See
      `lockRosterCapacity`.
    */
    const [league] = await tx.query<{ state: string }>(
      "SELECT state FROM leagues WHERE id = $1 FOR SHARE",
      [input.leagueId],
    );
    if (!league) throw new IrError("League has no rules", "LEAGUE_NOT_FOUND");
    refuseUnlessIrIsOpen(league.state, "ACTIVATE");

    /*
      Locked, because this reads every row of the roster and then writes one of
      them — one manager with two tabs, where both reads see a roster with only
      their own flip pending and the two `UPDATE`s touch different rows, so
      nothing conflicts. Textbook write skew, and `FOR UPDATE` is what stops
      that half of it. The key above is what stops the insert.
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
