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

/**
 * The namespace every roster-capacity key is taken in.
 *
 * A constant so one grep finds every site, and so a call site cannot drift onto
 * a namespace of its own — which would leave each path serialised against itself
 * and against nothing else, with every test still green. `membership.ts` holds
 * the only other namespace in the schema, `teams.slot`, and the two are never
 * held in one transaction.
 */
export const CAPACITY_LOCK_NAMESPACE = "roster.capacity";

/**
 * The serialisation point for every capacity check in this repo.
 *
 * ## Why an advisory key and not `teams … FOR UPDATE`
 *
 * `membership.ts` asked this exact question for the league's seat count (#73)
 * and answered it: a row lock there "would put a `teams`-then-`leagues` edge in
 * reach of the draft path", so it took a private advisory key instead, because
 * "nothing takes this advisory key anywhere else in the schema, so no cycle
 * through it can exist at all". The same holds here, and the cycle a `teams` row
 * lock would open is already written down at `lockRosterRow` in `waivers.ts`:
 * `processWaivers` runs leagues → roster_entries → **teams**, ending by writing
 * every team's waiver priority, and a path holding a `teams` row while waiting on
 * the league closes it. That is `40P01`, hourly, and a waiver run rolls back a
 * whole league's cycle when it aborts.
 *
 * ## Why a lock at all, when `heldForCapacity({ lock: true })` exists
 *
 * `FOR UPDATE OF r` locks rows already visible to the statement's snapshot. That
 * stops two writers flipping the same rows — the write skew it was added for —
 * and it cannot stop an **insert**, because a row that does not yet exist is a
 * phantom and no row lock under READ COMMITTED blocks one. So an
 * `addFreeAgent` and an `activateFromIr` on one team both read the same roster,
 * both find room, and land the team one over.
 *
 * Two transactions raising one team's counted size therefore need an object they
 * are guaranteed to contend for *whatever rows they touch*, and the team's
 * identity is the only such object.
 *
 * ## Call it first, before every other lock in the transaction
 *
 * Two independent properties, and only the first is positional:
 *
 * 1. A transaction **waiting** here holds nothing, so this key can never be the
 *    closing edge of a cycle. This is what is spent by moving the call below the
 *    league's `FOR SHARE` — which is why it goes above it, rather than in the
 *    tidier-looking spot.
 * 2. Two transactions **holding** keys took them in ascending key order from one
 *    namespace, so neither can hold one the other wants. That one survives
 *    moving the call; it is `lockKeysFor` that carries it.
 *
 * ## Ordered on the keys, not on the team ids
 *
 * The lock object is `hashtext(teamId)`, and `hashtext` is 32 bits, so the map
 * from id to key is not injective. Sorting the **ids** would therefore only order
 * the keys when no two collide: with `hashtext(B) = hashtext(C)` and `C < A < B`,
 * an acceptance between A and B would take ⟨hA, hB⟩ while one between A and C
 * took ⟨hB, hA⟩ — the exact cycle the sort exists to make unconstructible, with
 * no other function involved. So the keys are read back and sorted as keys.
 *
 * That costs a round trip, and it is paid by every caller rather than only by
 * the two that name a pair: the key is Postgres's to compute, so even one has
 * to be read back before it can be taken. Taking it inline was cheaper and was
 * wrong. A collision then costs what it should — two unrelated teams
 * serialised, and nothing else.
 *
 * ## What no test here can show
 *
 * PGlite is a single connection, so nothing in this repo exercises the
 * contention this exists for — a second transaction never runs. What is
 * testable is that the statement is issued, on the transaction's own handle,
 * before every read it has to dominate, in a deterministic order.
 * `capacityLockOrder` is split out so the ordering can be checked without a
 * database. The rest is a Postgres guarantee plus the argument above, and has to
 * be got right by reading — the same position `membership.ts` is in.
 */
export async function lockRosterCapacity(
  tx: SqlClient,
  ...teamIds: readonly string[]
): Promise<void> {
  for (const key of await lockKeysFor(tx, teamIds)) {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1), $2)", [
      CAPACITY_LOCK_NAMESPACE,
      key,
    ]);
  }
}

/**
 * The keys for these teams, in the order they must be taken.
 *
 * One statement, because `hashtext` is Postgres's and there is no honest way to
 * compute it here.
 *
 * A single team still costs a statement — the key has to come from the database
 * either way. What it skips is the `unnest` and the ordering, which would be
 * arranging one element. `acceptTrade` and `resolveTrade` are the two callers
 * that name more than one.
 */
async function lockKeysFor(
  tx: SqlClient,
  teamIds: readonly string[],
): Promise<readonly number[]> {
  const ids = capacityLockOrder(teamIds);
  if (ids.length === 0) return [];
  if (ids.length === 1) {
    const [row] = await tx.query<{ key: number }>("SELECT hashtext($1) AS key", [ids[0]]);
    return [row!.key];
  }

  const rows = await tx.query<{ key: number }>(
    "SELECT hashtext(id) AS key FROM unnest($1::text[]) AS t(id) ORDER BY 1",
    [ids],
  );
  // Sorted here as well as in SQL. `ORDER BY` fixes the order of the rows this
  // statement returns, and that is what is relied on — but the ordering is the
  // whole of the deadlock argument, so it is cheap to make it independent of how
  // the rows arrive.
  return rows.map((row) => row.key).sort((a, b) => a - b);
}

/**
 * The teams, deduplicated and in a stable order.
 *
 * Deduplicated because a caller naming one team twice would otherwise wait on a
 * key it already holds — harmless, since `pg_advisory_xact_lock` is re-entrant
 * within a transaction, but it would spend a round trip and read as though the
 * second call meant something.
 *
 * The order here is **not** the order the locks are taken in; `lockKeysFor`
 * re-orders on the keys, because the id-to-key map is not injective. This exists
 * to make the input to that deterministic, so two callers naming the same pair
 * hand it the same array.
 */
export function capacityLockOrder(teamIds: readonly string[]): readonly string[] {
  return [...new Set(teamIds)].sort();
}
