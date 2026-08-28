import { buildRosterShape, NFL, rosterOverage } from "@rostr/core";
import type { LeagueRules, RosterOverage } from "@rostr/core";
import type { SqlClient } from "./client.js";

/**
 * Whether a team is over its roster limit, and what that costs it.
 *
 * A team can only get here one way, and it is not something the manager did: a
 * player stashed on injured reserve recovers, the exemption is read live, and
 * the counted size rises with no row written and nobody having acted. That can
 * happen directly, or by letting a trade the team legitimately had room for
 * land them over after a recovery during the veto window.
 *
 * The state is allowed — nothing is forced off a roster on a provider's say-so,
 * which is the rule the whole injured-reserve design is built on. What happens
 * instead is that the league stops acting on the manager's behalf until they
 * resolve it: they cannot sign anyone, cannot be awarded a claim, cannot change
 * their lineup, and the autofill will not pick players for them.
 *
 * **A leaf module on purpose.** `notifications.ts` needs this and imports almost
 * nothing; `lineups.ts` needs it too, and `lineups.ts → trades.ts → week.ts →
 * lineups.ts` is a cycle waiting for anyone who reaches for the trade helpers
 * from here. Taking already-loaded rules as an argument rather than fetching
 * them keeps this file importing only `@rostr/core` and the client type, which
 * makes the cycle unconstructible rather than merely absent.
 */

/** Every unreleased row a team holds, with the designation read live. */
export async function heldForCapacity(
  db: SqlClient,
  teamId: string,
  options?: { readonly lock?: boolean },
): Promise<{ playerId: string; onIr: boolean; injuryDesignation: string | null }[]> {
  /*
    `FOR UPDATE OF r` when the caller is about to write, and never on the joined
    `players` rows — the designation is read here and never written, and locking
    a shared player row would serialise every team in the league behind one
    manager's move.
  */
  const rows = await db.query<{
    player_id: string;
    on_ir: boolean;
    designation: string | null;
  }>(
    `SELECT r.player_id, r.on_ir, p.injury_designation AS designation
       FROM roster_entries r
       JOIN players p ON p.id = r.player_id
      WHERE r.team_id = $1 AND r.released_at IS NULL
      ${options?.lock ? "FOR UPDATE OF r" : ""}`,
    [teamId],
  );

  return rows.map((row) => ({
    playerId: row.player_id,
    onIr: row.on_ir,
    injuryDesignation: row.designation,
  }));
}

/** How far past its limit this team is. */
export async function overageFor(
  db: SqlClient,
  teamId: string,
  rules: LeagueRules,
  options?: { readonly lock?: boolean },
): Promise<RosterOverage> {
  const shape = buildRosterShape(rules.roster, NFL);
  const roster = await heldForCapacity(db, teamId, options);

  return rosterOverage({
    roster,
    totalSlots: shape.totalSlots,
    irSlots: shape.irSlots,
  });
}

/**
 * What a manager over the limit is told, or `null` when they are not over.
 *
 * Pure, and separated from the query for the reason `marketClosedReason` is:
 * `apps/web` cannot render a component in a test, so a sentence composed inside
 * one is verified only by being run in production. This is the half that gets a
 * test, and the same function composes the refusal the server throws and the
 * notice the screen renders — so the two cannot say different things.
 *
 * It names no player. Any active player resolves this, so there is nothing to
 * go and find, and the obvious name to print would be the recovered player —
 * who is usually the right man to release, but not always, and the product
 * should not appear to be asking for him specifically.
 *
 * It does give advice, where the cut-player notification deliberately does not.
 * That convention holds for a fact whose remedy is a judgement call. Here the
 * remedy is the only exit, and the product has just taken two other controls
 * away — withholding the one instruction that works is the defect issue #273
 * describes, not a principle.
 */
export function overLimitNotice(overage: RosterOverage): string | null {
  if (!overage.over) return null;

  const players = overage.mustRelease === 1 ? "one player" : `${overage.mustRelease} players`;

  return (
    `Your roster holds ${overage.counted} players and the limit is ${overage.limit} — ` +
    `release ${players}. Until then you cannot change your lineup, the autofill will not ` +
    `pick anyone for you, and you cannot add anybody.`
  );
}
