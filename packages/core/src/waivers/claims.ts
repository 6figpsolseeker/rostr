/**
 * Resolving waiver claims.
 *
 * Claims are **blind**: nobody sees anyone else's until they process. That is
 * the property that makes waivers fair, and the one place this project could
 * eventually beat ESPN — there, you trust their server not to peek before
 * processing; a commit-reveal scheme would make it provable. Not v1.
 *
 * **Blind means no team's outcome depends on when another team filed**, and the
 * resolution below is written so it does not: waiver priority decides every
 * contest *between* teams, and submission time is consulted only to order one
 * team's own claims against each other. Filing early buys you nothing against
 * anybody but yourself. A commit-reveal scheme still works — a team commits to
 * its own ordering inside the commitment and reveals it to nobody early.
 *
 * This paragraph used to claim the stronger property, that the resolution was
 * "deliberately independent of *when* claims arrived", and the code never
 * implemented it either. Two claims by one team tie on priority, so the sort
 * fell through to `claimId` — `gen_random_uuid()`, a v4 UUID. A coin flip
 * decided which of a team's own claims was tried first, and therefore which
 * player was still on the board for the next team down: it moved outcomes
 * *across* teams, not merely within one.
 *
 * Resolution is otherwise simple and entirely deterministic:
 *
 *   1. Sort claims by the claiming team's waiver priority, then by the order
 *      that team filed its own.
 *   2. Award each in turn, skipping any whose player is already gone or whose
 *      roster cannot take him.
 *   3. A team that wins moves to the back of the order. A team that loses does
 *      not move at all.
 */

import type { DraftablePlayer, RosterShape } from "../draft/roster.js";
import { irExemptOnRoster } from "../season/injured-reserve.js";
import { canDraft } from "../draft/roster.js";

export interface WaiverClaim {
  readonly claimId: string;
  readonly teamId: string;
  readonly addPlayerId: string;
  /** Player to drop to make room. Required when the roster is full. */
  readonly dropPlayerId: string | null;
  /**
   * When the team filed this claim — `waiver_claims.created_at`.
   *
   * Orders a team's *own* claims against each other and decides nothing else;
   * see the sort in `resolveWaiverClaims`. It is data on the claim rather than
   * a clock read, so the function stays pure and a disputed run replays from
   * the stored rows exactly.
   */
  readonly submittedAt: Date;
}

export type ClaimFailure =
  "PLAYER_TAKEN" | "ROSTER_FULL" | "ALREADY_ROSTERED" | "DROP_NOT_ON_ROSTER" | "DROP_ON_IR";

export interface ClaimOutcome {
  readonly claimId: string;
  readonly teamId: string;
  readonly addPlayerId: string;
  readonly awarded: boolean;
  readonly reason?: ClaimFailure;
}

export interface WaiverResolution {
  readonly outcomes: readonly ClaimOutcome[];
  /**
   * Waiver priority after processing, best first.
   *
   * Winners move to the back in the order they won, so a team that wins with
   * the top priority ends up behind a team that wins with the second.
   */
  readonly priorityAfter: readonly string[];
}

export interface ResolveInput {
  readonly claims: readonly WaiverClaim[];
  /** Team IDs in waiver priority order, best first. */
  readonly priority: readonly string[];
  /** Current rosters by team ID. */
  readonly rosters: ReadonlyMap<string, readonly DraftablePlayer[]>;
  readonly pool: ReadonlyMap<string, DraftablePlayer>;
  readonly shape: RosterShape;
  /*
    Players stashed on injured reserve who currently qualify for it — the flag
    **and** a live eligible designation, decided by the caller.

    League-wide and unkeyed by team: a player is on one roster at a time, so the
    team is already unambiguous, and a set applied to the array being counted
    cannot disagree with that array about who is on it.

    **Uncapped here.** `irSlots` binds per claim, against the roster the drop
    would actually leave behind — see the count below.

    **Required, so a caller cannot forget it.** An empty set is the honest answer
    for a league whose signed rules grant no IR; defaulting to one would be the
    same shape as an optional filter defaulting to "all", which this repo has
    already established is not a filter. Forgetting it here reinstates #237.
  */
  readonly irExempt: ReadonlySet<string>;
}

/**
 * Resolve a round of waiver claims.
 *
 * Pure: no clock, no database. `submittedAt` arrives as data on each claim —
 * this function never asks what time it is — so the same inputs always produce
 * the same outcomes, which is what lets a disputed waiver run be replayed
 * exactly.
 */
export function resolveWaiverClaims(input: ResolveInput): WaiverResolution {
  const { claims, priority, rosters, pool, shape, irExempt } = input;

  const rank = new Map(priority.map((teamId, index) => [teamId, index]));

  // Priority first. Then, within one team, the order that team filed its own
  // claims, so a manager with one open spot and two claims gets the player they
  // asked for first. `claimId` closes the sort so it stays total: a comparator
  // that returned 0 for two distinct claims would leave the result riding on
  // `sort` stability, and therefore on database row order.
  //
  // **`submittedAt` is only ever compared between two claims that tied on
  // priority, and a tie means one team.** `loadWaiverPriority` lists every team
  // in the league exactly once, so two claims share a rank only when they share
  // a team. That is what keeps this blind: no team's outcome can move because of
  // when a *different* team filed.
  //
  // Do **not** try to enforce that by making the time term conditional on
  // `a.teamId === b.teamId`. It looks tighter and it is not transitive — A < B
  // by time, B < C by id, C < A by id is constructible — and a non-transitive
  // comparator makes the sort depend on input order, which is exactly the
  // replayability this function exists to provide.
  //
  // The one residue: claims from a team *absent* from `priority` share the
  // `MAX_SAFE_INTEGER` fallback, so two of those from different teams would
  // compare on time. Nothing produces that state — and such a claim would be
  // awarded a player in a league it does not belong to long before its ordering
  // mattered, which is a schema gap filed separately, not an ordering one.
  const ordered = [...claims].sort((a, b) => {
    const byPriority =
      (rank.get(a.teamId) ?? Number.MAX_SAFE_INTEGER) -
      (rank.get(b.teamId) ?? Number.MAX_SAFE_INTEGER);
    if (byPriority !== 0) return byPriority;

    const byTime = a.submittedAt.getTime() - b.submittedAt.getTime();
    return byTime !== 0 ? byTime : a.claimId.localeCompare(b.claimId);
  });

  const working = new Map<string, DraftablePlayer[]>(
    [...rosters].map(([teamId, roster]) => [teamId, [...roster]]),
  );
  const taken = new Set<string>();
  const outcomes: ClaimOutcome[] = [];
  const winners: string[] = [];

  for (const claim of ordered) {
    const base = {
      claimId: claim.claimId,
      teamId: claim.teamId,
      addPlayerId: claim.addPlayerId,
    };
    const player = pool.get(claim.addPlayerId);
    const roster = working.get(claim.teamId) ?? [];

    if (!player || taken.has(claim.addPlayerId)) {
      outcomes.push({ ...base, awarded: false, reason: "PLAYER_TAKEN" });
      continue;
    }

    // The drop is applied first, so a full roster with a valid drop succeeds.
    let afterDrop = roster;
    if (claim.dropPlayerId) {
      if (!roster.some((p) => p.playerId === claim.dropPlayerId)) {
        outcomes.push({ ...base, awarded: false, reason: "DROP_NOT_ON_ROSTER" });
        continue;
      }
      afterDrop = roster.filter((p) => p.playerId !== claim.dropPlayerId);
    }

    /*
      The exemption is counted against `afterDrop`, not against the roster as it
      stands. Issue #237.

      Dropping a stashed player frees an **IR** slot, not a roster slot — he was
      not occupying counted room to begin with. So a count decided before the
      drop keeps subtracting for somebody who has just left, and awards a claim
      that should be refused: at fourteen counted plus two stashed, dropping one
      of the stashed pair would read as thirteen and let a fifteenth counted
      player in.

      Intersecting with `afterDrop` also means a player in the set who is not in
      this array exempts nothing, which keeps the arithmetic right when the array
      is short of rows for reasons of its own.
    */
    const exempt = irExemptOnRoster(afterDrop, irExempt, shape.irSlots);

    /*
      Dropping the stashed player is the natural move once claims start working,
      and it is the one drop that frees nothing. Saying so is the difference
      between a mistake made once and a mistake made every Wednesday.
    */
    if (
      claim.dropPlayerId !== null &&
      irExempt.has(claim.dropPlayerId) &&
      afterDrop.length - exempt >= shape.totalSlots
    ) {
      outcomes.push({ ...base, awarded: false, reason: "DROP_ON_IR" });
      continue;
    }

    const legality = canDraft(afterDrop, player, shape, exempt);
    if (!legality.legal) {
      outcomes.push({ ...base, awarded: false, reason: legality.reason ?? "ROSTER_FULL" });
      continue;
    }

    working.set(claim.teamId, [...afterDrop, player]);
    taken.add(claim.addPlayerId);
    outcomes.push({ ...base, awarded: true });

    // A team moves once, however many claims it wins in a round.
    if (!winners.includes(claim.teamId)) winners.push(claim.teamId);
  }

  return {
    outcomes,
    priorityAfter: [...priority.filter((teamId) => !winners.includes(teamId)), ...winners],
  };
}

/**
 * Starting waiver priority: the reverse of the draft order.
 *
 * The team that picked last gets first claim, which is the same balancing
 * instinct the snake draft applies within a round.
 */
export function initialWaiverPriority(draftOrder: readonly string[]): readonly string[] {
  return [...draftOrder].reverse();
}
