/**
 * The second stats source, ingested and compared.
 *
 * `RULES.md` §7 wants two independent providers to agree before a week's scores
 * finalise. This is the half that can be built correctly today: both providers'
 * numbers land in `stat_lines` side by side, and every place they differ is
 * reported. **It does not gate finalisation**, and the reason is written down
 * rather than left to be inferred — see "What this deliberately does not do".
 *
 * Two functions, and both halves are real: {@link ingestSecondSource} writes the
 * second provider's week, and {@link compareSources} reads the two back and
 * reports every stat where they differ.
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

import type { StatLine } from "@rostr/core";
import { sleeperPlayerStats, sleeperTeamDefenseStats } from "@rostr/stats";
import type { SleeperWeek } from "@rostr/stats";
import type { SqlClient } from "./client.js";
import { PRIMARY_STAT_SOURCE } from "./lineups.js";
import { loadSportIds } from "./sports.js";
import { withTransaction } from "./transaction.js";

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
 * Write a second provider's week into `stat_lines`.
 *
 * The week is **passed in rather than fetched**, exactly as `drawDraftOrder`
 * takes a beacon: `@rostr/db` holds no HTTP client and should not gain one, and
 * a caller that must supply real data cannot accidentally test against none.
 *
 * ## Joining
 *
 * `players.second_source_ref` is the whole join — Sleeper's numeric id for a
 * player, and its **team abbreviation** for a D/ST, which is why Washington
 * needs an alias (`WSH` here, `WAS` there) and gets one in the adapter.
 * Nothing here matches on a name; a name match is how a D/ST ends up on the
 * wrong roster.
 *
 * `unjoined` is returned rather than swallowed. A join that quietly covers
 * fewer players each week is indistinguishable from two sources that
 * increasingly agree, which is the failure that makes a second source
 * worthless.
 *
 * ## Why there is no retraction
 *
 * The primary ingest retracts — it writes a zero when a stat it previously
 * recorded disappears — because a stale stat there decides a matchup. **Nothing
 * scores from this source.** Every scoring read filters to
 * `PRIMARY_STAT_SOURCE`, so a stale second-source row can only ever cause a
 * disagreement to be *reported*, and reporting one stat too many is the safe
 * direction for a comparison whose entire job is to surface differences.
 *
 * Retraction here would also need the thing that makes it safe there: a list of
 * players the response *covered*. A week endpoint returns whoever scored, so
 * absence means "nothing happened", not "not covered" — and writing zeroes on
 * that basis is how a truncated response wipes a week.
 */
export async function ingestSecondSource(
  db: SqlClient,
  input: {
    readonly sportKey: string;
    readonly season: number;
    readonly week: number;
    /** The provider's week, keyed by their player id or team abbreviation. */
    readonly stats: SleeperWeek;
    readonly source?: string;
  },
): Promise<SecondSourceResult> {
  const source = input.source ?? SECOND_STAT_SOURCE;
  const ids = await loadSportIds(db, input.sportKey);

  const players = await db.query<{
    id: string;
    second_source_ref: string;
    is_defense: boolean;
  }>(
    `SELECT p.id, p.second_source_ref, (pos.key = 'DEF') AS is_defense
       FROM players p
       JOIN positions pos ON pos.id = p.primary_position_id
      WHERE p.sport_id = $1 AND p.second_source_ref IS NOT NULL`,
    [ids.sportId],
  );

  const byRef = new Map(players.map((row) => [row.second_source_ref, row]));

  const rowPlayer: string[] = [];
  const rowStatKey: string[] = [];
  const rowValue: number[] = [];
  let joined = 0;
  let unjoined = 0;

  for (const [ref, raw] of Object.entries(input.stats)) {
    const player = byRef.get(ref);
    if (!player) {
      unjoined++;
      continue;
    }
    joined++;

    // A D/ST and a player are different translations of the same shape — the
    // provider's defensive fields mean nothing on a running back.
    const lines: readonly StatLine[] = player.is_defense
      ? sleeperTeamDefenseStats(raw)
      : sleeperPlayerStats(raw);

    for (const line of lines) {
      const statKeyId = ids.statKeyIds.get(line.statKey);
      if (!statKeyId) {
        // Loud, like the primary ingest. The registry and a provider map
        // having diverged should fail rather than drop a stat silently.
        throw new Error(
          `Second source references unknown stat key "${line.statKey}". ` +
            `The sport registry and the provider map have diverged.`,
        );
      }
      rowPlayer.push(player.id);
      rowStatKey.push(statKeyId);
      rowValue.push(line.value);
    }
  }

  const written =
    rowValue.length === 0
      ? 0
      : await writeRows(db, {
          season: input.season,
          week: input.week,
          source,
          rowPlayer,
          rowStatKey,
          rowValue,
        });

  return {
    written,
    joined,
    unjoined,
    disagreements: await compareSources(
      db,
      input.sportKey,
      input.season,
      input.week,
      PRIMARY_STAT_SOURCE,
      source,
    ),
  };
}

/**
 * Insert a revision for every value that is new or has changed.
 *
 * `box-scores.ts`' idiom, minus the retraction: three arrays and three scalars,
 * so it is **six bind parameters however many rows** and the 65535 parameter cap
 * is structurally unreachable rather than avoided by chunking.
 *
 * A value identical to the one already stored writes nothing, so re-running a
 * week is free and the revision number stays a record of actual corrections.
 */
async function writeRows(
  db: SqlClient,
  input: {
    readonly season: number;
    readonly week: number;
    readonly source: string;
    readonly rowPlayer: readonly string[];
    readonly rowStatKey: readonly string[];
    readonly rowValue: readonly number[];
  },
): Promise<number> {
  return withTransaction(db, async (tx) => {
    const rows = await tx.query<{ id: string }>(
      `WITH incoming (player_id, stat_key_id, value) AS (
         SELECT * FROM unnest($4::uuid[], $5::uuid[], $6::integer[])
       ),
       cur AS (
         SELECT c.player_id, c.stat_key_id, c.value, c.revision
           FROM stat_lines_current c
          WHERE c.season = $1 AND c.week = $2 AND c.source = $3
            AND c.player_id = ANY($4::uuid[])
       )
       INSERT INTO stat_lines
              (player_id, season, week, stat_key_id, value, source, revision)
       SELECT i.player_id, $1, $2, i.stat_key_id, i.value, $3,
              COALESCE(c.revision + 1, 0)
         FROM incoming i
         LEFT JOIN cur c
           ON c.player_id = i.player_id AND c.stat_key_id = i.stat_key_id
        WHERE c.player_id IS NULL OR c.value IS DISTINCT FROM i.value
       RETURNING id`,
      [
        input.season,
        input.week,
        input.source,
        input.rowPlayer,
        input.rowStatKey,
        input.rowValue,
      ],
    );

    // `PostgresClient.query` discards `rowCount`, so the count is only knowable
    // because the statement ends in `RETURNING` — the same reason
    // `resolveLeagueWeek` returns ids it does not use.
    return rows.length;
  });
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
 * Only stats **both** sources reported **for that player, that week** are
 * compared. Absence is not zero, and treating it as zero would invent a
 * disagreement out of a gap in coverage.
 *
 * The example this comment used to give was wrong and is worth correcting rather
 * than deleting: it said Sleeper carries no `def_yds_allowed`. It does —
 * `yds_allow`, 231 for Washington in week 1 of 2025 — and measured against the
 * live endpoint on 2026-08-22 the Sleeper translation emits **all 26** of the
 * sport's stat keys. There is no key only one provider can produce.
 *
 * What is real is the per-player gap: a provider that did not report a receiver
 * at all, or reported him with no receiving fields, leaves those stats absent on
 * one side. The inner join skips them. That matters most for
 * `def_pts_allowed`, where absent means a **shutout** rather than nothing — the
 * translator makes the same correction for the same reason.
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
