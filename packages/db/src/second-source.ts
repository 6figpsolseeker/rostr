/**
 * The second stats source, ingested and compared.
 *
 * `RULES.md` §7 wants two independent providers to agree before a week's scores
 * finalise. This is the half that can be built correctly today: both providers'
 * numbers land in `stat_lines` side by side, and every place they differ is
 * reported. **It does not gate finalisation**, and the reason is written down
 * rather than left to be inferred — see "What this deliberately does not do".
 *
 * ## Why the storage needed no change
 *
 * `stat_lines` has keyed on `source` since `0003` and `stat_lines_current` keys
 * on it too, so two providers are two rows and always were. `CLAUDE.md` records
 * that this was preserved on purpose: *"Collapsing them in the view or averaging
 * them away would delete that comparison at the storage layer and have to be
 * undone."* Nothing here undoes it, and nothing here changes a score — every
 * read filters to {@link PRIMARY_STAT_SOURCE}.
 *
 * ## What this deliberately does not do
 *
 * §7 says disagreement *"freezes that week for review"*. That is not built, and
 * building it today would be worse than not:
 *
 * - **Disagreement is common and mostly benign.** In the thirteen-game corpus
 *   the two sources differ on 5 of 26 team-games, and four of those are correct
 *   data — ESPN files a punt return by a defensive player in two places, and a
 *   kickoff recovery is deliberately unmatched by our classifiers. A gate
 *   freezing on any difference freezes most weeks.
 * - **A gate switched off in week 2 is worse than none**, because it teaches an
 *   operator to route around the mechanism that is supposed to stop week 14.
 * - **The tolerance cannot be designed without data, and this is what generates
 *   it.** The scoring table itself was settled by reconciling 11,507
 *   player-weeks rather than by picking a number; the gate deserves the same.
 * - **No money settles this season.** Pot leagues are closed for 2026, so §7's
 *   gate currently protects a payout that is not happening. Stalling brackets to
 *   protect nothing is a poor trade.
 *
 * So §7 remains partly unimplemented and this file says so plainly. It sits
 * beside `settlement.requiredOracleSources`, which has always been in the frozen
 * rule set and enforced nowhere.
 */

import type { SqlClient } from "./client.js";
import { loadSportIds } from "./sports.js";

/**
 * Where second-source rows are filed.
 *
 * A sibling of {@link PRIMARY_STAT_SOURCE} rather than a variant of it: the two
 * are separate opinions and the whole point is that they can differ.
 */
export const SECOND_STAT_SOURCE = "sleeper";

/** One stat where the two providers disagree. */
export interface SourceDisagreement {
  readonly playerRef: string;
  readonly playerName: string;
  readonly statKey: string;
  readonly primary: number;
  readonly second: number;
}

export interface SecondSourceResult {
  /** Rows written, counting a corrected revision as a write. */
  readonly written: number;
  /** Players in the provider's week we could join to one of ours. */
  readonly joined: number;
  /**
   * Players in the provider's week we could not join.
   *
   * Reported rather than swallowed. A join that quietly covers fewer players
   * each week is indistinguishable from two sources that increasingly agree,
   * which is the failure mode that makes a second source worthless.
   */
  readonly unjoined: number;
  readonly disagreements: readonly SourceDisagreement[];
}

/**
 * Compare the two sources for a week, from what is already stored.
 *
 * **Per stat, never per total.** The conformance corpus already paid for this
 * lesson: gating on totals hid two real `def_pts_allowed` divergences of six and
 * two points, because both readings fell in the same scoring tier and paid the
 * same. A tier is a range, so a gap worth nothing this week is worth six the
 * week it straddles a boundary.
 *
 * Only stats **both** sources reported are compared. A stat one of them does not
 * carry is not a disagreement — Sleeper has no `def_yds_allowed`, and reading
 * its absence as zero would report every defence in the league as disputed.
 */
export async function compareSources(
  db: SqlClient,
  sportKey: string,
  season: number,
  week: number,
  primarySource: string,
  secondSource: string = SECOND_STAT_SOURCE,
): Promise<readonly SourceDisagreement[]> {
  const ids = await loadSportIds(db, sportKey);

  const rows = await db.query<{
    external_ref: string;
    full_name: string;
    stat_key: string;
    primary_value: string;
    second_value: string;
  }>(
    `SELECT p.external_ref, p.full_name, sk.key AS stat_key,
            a.value::text AS primary_value, b.value::text AS second_value
       FROM stat_lines_current a
       JOIN stat_lines_current b
         ON b.player_id = a.player_id
        AND b.season = a.season AND b.week = a.week
        AND b.stat_key_id = a.stat_key_id
        AND b.source = $5
       JOIN players p ON p.id = a.player_id
       JOIN stat_keys sk ON sk.id = a.stat_key_id
      WHERE p.sport_id = $1
        AND a.season = $2 AND a.week = $3
        AND a.source = $4
        AND a.value IS DISTINCT FROM b.value
      ORDER BY p.full_name, sk.key`,
    [ids.sportId, season, week, primarySource, secondSource],
  );

  return rows.map((row) => ({
    playerRef: row.external_ref,
    playerName: row.full_name,
    statKey: row.stat_key,
    primary: Number(row.primary_value),
    second: Number(row.second_value),
  }));
}
