/**
 * Resolving waiver claims.
 *
 * Claims are **blind**: nobody sees anyone else's until they process. That is
 * the property that makes waivers fair, and the one place this project could
 * eventually beat ESPN — there, you trust their server not to peek before
 * processing; a commit-reveal scheme would make it provable. Not v1, but the
 * resolution below is deliberately independent of *when* claims arrived, so
 * adding that later changes nothing here.
 *
 * Resolution is otherwise simple and entirely deterministic:
 *
 *   1. Sort claims by the claiming team's waiver priority.
 *   2. Award each in turn, skipping any whose player is already gone or whose
 *      roster cannot take him.
 *   3. A team that wins moves to the back of the order. A team that loses does
 *      not move at all.
 */

import type { DraftablePlayer, RosterShape } from "../draft/roster.js";
import { canDraft } from "../draft/roster.js";

export interface WaiverClaim {
  readonly claimId: string;
  readonly teamId: string;
  readonly addPlayerId: string;
  /** Player to drop to make room. Required when the roster is full. */
  readonly dropPlayerId: string | null;
}

export type ClaimFailure =
  "PLAYER_TAKEN" | "ROSTER_FULL" | "ALREADY_ROSTERED" | "DROP_NOT_ON_ROSTER";

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
}

/**
 * Resolve a round of waiver claims.
 *
 * Pure: no clock, no database. The same inputs always produce the same
 * outcomes, which is what lets a disputed waiver run be replayed exactly.
 */
export function resolveWaiverClaims(input: ResolveInput): WaiverResolution {
  const { claims, priority, rosters, pool, shape } = input;

  const rank = new Map(priority.map((teamId, index) => [teamId, index]));

  // Priority first, then submission order within a team so a team's own claims
  // resolve in the order they intended. `claimId` breaks any remaining tie,
  // because a resolution that depended on array order would not be replayable.
  const ordered = [...claims].sort((a, b) => {
    const byPriority =
      (rank.get(a.teamId) ?? Number.MAX_SAFE_INTEGER) -
      (rank.get(b.teamId) ?? Number.MAX_SAFE_INTEGER);
    return byPriority !== 0 ? byPriority : a.claimId.localeCompare(b.claimId);
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

    const legality = canDraft(afterDrop, player, shape);
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
