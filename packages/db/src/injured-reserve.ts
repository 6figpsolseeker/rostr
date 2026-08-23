import { buildRosterShape, NFL, refuseIrPlacement } from "@rostr/core";
import type { IrPlacementRefusal } from "@rostr/core";
import { getLeagueRules } from "./leagues.js";
import type { SqlClient } from "./client.js";
import { withTransaction } from "./transaction.js";

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
    readonly code: IrPlacementRefusal | "LEAGUE_NOT_FOUND" | "NOT_ON_IR" | "GAME_STARTED",
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
 * **Never refused for capacity**, and that is the important asymmetry. A team
 * whose stashed player recovered is already over the counted limit — the
 * exemption evaporated the moment his designation cleared — so refusing to
 * activate him would trap the roster in the illegal state rather than let the
 * manager resolve it. Activation is the fix, not the offence.
 *
 * Nor does it check the kickoff. Coming off IR only ever *adds* to what counts
 * against the limit, so it cannot be used to dodge anything mid-game, and the
 * lineup lock still decides whether he can actually be started.
 */
export async function activateFromIr(
  db: SqlClient,
  input: {
    readonly leagueId: string;
    readonly teamId: string;
    readonly playerId: string;
  },
): Promise<{ playerId: string }> {
  const rows = await db.query<{ player_id: string }>(
    `UPDATE roster_entries SET on_ir = false
      WHERE team_id = $1 AND player_id = $2 AND released_at IS NULL AND on_ir
      RETURNING player_id`,
    [input.teamId, input.playerId],
  );

  if (rows.length === 0) {
    throw new IrError("That player is not on injured reserve.", "NOT_ON_IR");
  }

  return { playerId: input.playerId };
}
