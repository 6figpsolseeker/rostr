import type { Tiebreaker } from "@rostr/core";

/**
 * What each tiebreaker is called, on every screen (#74).
 *
 * The join screen showed the raw tokens — `WIN_PCT → … → LOWEST_TEAM_ID` — in
 * the document a member reads immediately before signing, while the standings
 * screen had its own prose. One map, so the two cannot disagree. Typed on the
 * union, so a new tiebreaker fails to compile until it has a name.
 *
 * The last one says the id is random, because that is the fact a member needs:
 * it is a coin flip fixed at joining, not a criterion.
 */
export const TIEBREAKER_LABELS: Record<Tiebreaker, string> = {
  WIN_PCT: "record",
  POINTS_FOR: "points for",
  HEAD_TO_HEAD: "head-to-head",
  POINTS_AGAINST: "points against",
  LOWEST_TEAM_ID: "team ID (random, set on joining)",
};

/**
 * The "on points for" chip beside a standings row, or nothing.
 *
 * Before a game is played every team is 0-0 on zero points, so the chain falls
 * through to the team id and stamps it on every row but the first. Nothing has
 * been decided yet, so labelling how it was decided is noise.
 */
export function decidedByLabel(
  decidedBy: Tiebreaker | null,
  weeksPlayed: number,
): string | null {
  return decidedBy && weeksPlayed > 0 ? `on ${TIEBREAKER_LABELS[decidedBy]}` : null;
}
