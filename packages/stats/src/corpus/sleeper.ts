/**
 * Sleeper's weekly stat line, read into our stat keys.
 *
 * ## Why Sleeper, and why not Sleeper's points
 *
 * `RULES.md` §7 wants two independent sources to agree before a paying week
 * finalises, and Sleeper is the only genuine second opinion available: ESPN is
 * not one, because Tank01 is an ESPN re-serialisation — see
 * `docs/TANK01.md` and {@link ./espn.ts}.
 *
 * **The comparison is of stats, never of points.** Sleeper's scoring table is
 * not ours — they pay 4 for a passing touchdown in some formats and 6 in
 * others, their D/ST ladders are shaped differently, and their `pts_ppr` bakes
 * in bonuses (`bonus_rec_yd_100`, `bonus_pass_yd_300`) that our table does not
 * have at all. Comparing `pts_ppr` against our total would disagree on almost
 * every player, which would force an exceptions list long enough to be
 * meaningless — and an exceptions list is where a real defect hides. So their
 * raw stats are mapped into our keys and run through **our own `scorePlayer`**.
 * Any disagreement that survives that is a disagreement about what happened on
 * the field, which is the only kind worth reporting.
 *
 * ## Absent is zero here, and that is not the rule elsewhere
 *
 * Sleeper omits a key rather than sending a zero, exactly as Tank01 omits an
 * empty category. For an ordinary counter that is the same thing. For the two
 * **tiered** rules it is not — a defence that allowed nothing has no
 * `pts_allow` key — so {@link sleeperTeamDefenseStats} emits `def_pts_allowed`
 * and `def_yds_allowed` explicitly, the same correction `box-score.ts` makes on
 * the Tank01 side and for the same reason: the scoring engine reads an absent
 * tiered stat as "did not play".
 */

import type { StatLine } from "@rostr/core";

/** One week of one player's stats, as Sleeper serves them. Every value is a number. */
export type SleeperStats = Readonly<Record<string, number>>;

/**
 * Sleeper field -> our stat key, where the two are one-to-one.
 *
 * Every name here was read off a live response rather than documentation —
 * `https://api.sleeper.app/v1/stats/nfl/regular/<season>/<week>`, six weeks
 * across 2024 and 2025, unioned. The fields that are **not** one-to-one are
 * handled below, and each has a reason.
 */
const SLEEPER_PLAYER_MAP: Readonly<Record<string, string>> = {
  pass_yd: "pass_yd",
  pass_td: "pass_td",
  pass_int: "pass_int",

  rush_yd: "rush_yd",
  rush_td: "rush_td",

  rec: "rec",
  rec_yd: "rec_yd",
  rec_td: "rec_td",

  fum_lost: "fum_lost",

  // Kicking. Sleeper's buckets are finer than ours below 40 and identical above
  // it, which is why only the bottom three collapse.
  fgm_40_49: "fg_40_49",
  fgm_50_59: "fg_50_59",
  fgm_60p: "fg_60_plus",
  xpm: "xp_made",
};

/**
 * Sleeper fields deliberately **not** read, and why.
 *
 * Named rather than merely omitted, because each is a plausible-looking key
 * that would double-count if it were added next to the ones above.
 *
 *   - `fgm_50p`   — a superset of `fgm_50_59` + `fgm_60p`, both of which are
 *                   mapped. Reading all three pays a 58-yarder twice.
 *   - `fgmiss_*`  — the distance split of `fgmiss`, which is mapped whole.
 *   - `td`        — every touchdown of every kind, already counted by
 *                   `pass_td` / `rush_td` / `rec_td` / `st_td`.
 *   - `anytime_tds`, `first_td` — betting markets, not stats.
 *   - `kr_td`, `pr_td`, `blk_pr_td` — the components of `st_td`, which is
 *                   mapped. See {@link sleeperPlayerStats}.
 *   - `idp_*`     — individual defensive player scoring. There is no IDP slot in
 *                   this product, and `stat-map.ts` explains at length why a
 *                   per-player defensive stat is a duplicate rather than an
 *                   unused row.
 *   - `fum_rec`   — for a *player*, this is recovering any fumble including his
 *                   own, the exact contamination `Defense.fumblesRecovered`
 *                   carries on the Tank01 side. It is scored only for the unit.
 *   - `misc_td`   — **present in the corpus and the most dangerous of these.**
 *                   Sleeper files a return touchdown under `st_td` *and* under
 *                   `misc_td`; Kneeland in `20251103_ARI@DAL` and Hunter Long in
 *                   `20241208_BUF@LAR` carry both. Reading it pays the play twice.
 *   - `fgm`       — the sum of every made-field-goal bucket, all of which are
 *                   mapped. Eighteen occurrences here, and it looks exactly like
 *                   the field you want.
 *   - `xpmiss`    — a missed extra point. Our table does not score one.
 *   - `fg_blkd`,  — **filed against the team whose kick was blocked**, not the
 *     `punt_blkd`   one that blocked it. `20250907_ARI@NO` has `fg_blkd` on ARI
 *                   while the credit correctly sits on NO as `blk_kick`. Mapping
 *                   either to `def_blk_kick` would pay the wrong unit.
 *
 * `kr_td`, `pr_td` and `blk_pr_td` appear in no corpus game — `st_td` is what
 * Sleeper actually populates. They are listed because they are the components of
 * a field that *is* mapped, and would double-count if a future capture carried
 * them.
 */
export const SLEEPER_UNMAPPED_PLAYER_FIELDS: readonly string[] = [
  "fgm",
  "fgm_50p",
  "fgmiss_30_39",
  "fgmiss_40_49",
  "fgmiss_50_59",
  "fgmiss_50p",
  "fgmiss_60p",
  "xpmiss",
  "td",
  "misc_td",
  "anytime_tds",
  "first_td",
  "kr_td",
  "pr_td",
  "blk_pr_td",
  "fum_rec",
  "fg_blkd",
  "punt_blkd",
];

/**
 * Sleeper D/ST fields deliberately **not** read.
 *
 * The unit side needs this list as much as the player side does, and did not
 * have one. `misc_td` duplicates `def_st_td` for four units in the corpus, and
 * `fg_blkd`/`punt_blkd` sit on the team that was blocked rather than the team
 * that blocked — `blk_kick` is the one that credits the right unit.
 */
export const SLEEPER_UNMAPPED_DST_FIELDS: readonly string[] = [
  "misc_td",
  "fg_blkd",
  "punt_blkd",
  "pts_allow_0",
  "pts_allow_1_6",
  "pts_allow_7_13",
  "pts_allow_14_20",
  "pts_allow_21_27",
  "pts_allow_28_34",
  "pts_allow_35p",
];

/** Sleeper D/ST field -> our stat key, where the two are one-to-one. */
const SLEEPER_DST_MAP: Readonly<Record<string, string>> = {
  sack: "def_sack",
  int: "def_int",
  safe: "def_safety",
  blk_kick: "def_blk_kick",
  def_2pt: "def_2pt_ret",
};

function add(into: Map<string, number>, statKey: string, value: number): void {
  if (value === 0) return;
  into.set(statKey, (into.get(statKey) ?? 0) + value);
}

function value(stats: SleeperStats, field: string): number {
  const raw = stats[field];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
}

function toStatLines(totals: ReadonlyMap<string, number>): StatLine[] {
  return [...totals]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([statKey, v]) => ({ statKey, value: v }));
}

/**
 * One Sleeper player-week, as stat lines in our vocabulary.
 *
 * Three fields are combined rather than mapped, and each combination is the
 * point of comparing against Sleeper at all:
 *
 * **Two-point conversions** are split three ways — `pass_2pt`, `rush_2pt`,
 * `rec_2pt` — where we have a single `two_pt`. Reading one of them would make
 * every conversion of the other two kinds look like a disagreement.
 *
 * **Field goals under 40** are split three ways where we have one bucket. Our
 * table pays the same for all of them, so the split carries no information we
 * can use, but dropping any of the three would under-count a kicker.
 *
 * **`st_td` is the return touchdown**, and it is Sleeper's *Special Teams
 * Player* category rather than their *Special Teams Defense* one. That
 * distinction is the whole reason a return touchdown is not double-counted
 * here: the same play pays the returner `st_td` and his unit `def_st_td`, on
 * two different roster spots, and Sleeper keeps them in separate fields exactly
 * as `RULES.md` §1 keeps `ret_td` separate from `def_td`. Its components
 * (`kr_td`, `pr_td`, `blk_pr_td`) are left alone for the same reason
 * `fgm_50p` is: adding a total to its own parts pays the play twice.
 */
export function sleeperPlayerStats(stats: SleeperStats): StatLine[] {
  const totals = new Map<string, number>();

  for (const [field, statKey] of Object.entries(SLEEPER_PLAYER_MAP)) {
    add(totals, statKey, value(stats, field));
  }

  add(
    totals,
    "two_pt",
    value(stats, "pass_2pt") + value(stats, "rush_2pt") + value(stats, "rec_2pt"),
  );

  add(
    totals,
    "fg_0_39",
    value(stats, "fgm_0_19") + value(stats, "fgm_20_29") + value(stats, "fgm_30_39"),
  );

  add(totals, "fg_missed", value(stats, "fgmiss"));
  add(totals, "ret_td", value(stats, "st_td"));

  return toStatLines(totals);
}

/**
 * One Sleeper D/ST week, as stat lines in our vocabulary.
 *
 * Two combinations, both load-bearing:
 *
 * **Fumble recoveries are `fum_rec` + `def_st_fum_rec`.** Sleeper files a
 * recovery made on a kick or punt in the second field, and both pay the unit.
 * Reading only `fum_rec` would report a disagreement on every muffed punt —
 * about a dozen a season, 2 points each — against a Tank01 side that has them.
 * **No corpus game carries `def_st_fum_rec`**, so that half of the sum is
 * reasoned rather than exercised; it is a game worth capturing when one turns up.
 *
 * **Touchdowns are `def_td` + `def_st_td`.** `RULES.md` §1 pays the unit 6 for
 * a "defensive **or special teams** touchdown" and we carry one key for both;
 * Sleeper carries two. Summing here is what makes our `def_td` comparable, and
 * it is also the check that catches the overlap `box-score.ts` spends a page
 * on — an ESPN-defensive return by a defensive player is one touchdown in
 * either vocabulary, and a translator that pays it twice shows up as a
 * 6-point excess right here.
 *
 * `pts_allow` and `yds_allow` are emitted even at zero. See the module note.
 */
export function sleeperTeamDefenseStats(stats: SleeperStats): StatLine[] {
  const totals = new Map<string, number>();

  for (const [field, statKey] of Object.entries(SLEEPER_DST_MAP)) {
    add(totals, statKey, value(stats, field));
  }

  add(totals, "def_fum_rec", value(stats, "fum_rec") + value(stats, "def_st_fum_rec"));
  add(totals, "def_td", value(stats, "def_td") + value(stats, "def_st_td"));

  // Absent is not zero for a tiered rule. A shutout carries no `pts_allow` key
  // at all, and a unit that gave up nothing has earned the top tier rather than
  // forfeited it.
  totals.set("def_pts_allowed", value(stats, "pts_allow"));
  totals.set("def_yds_allowed", value(stats, "yds_allow"));

  return toStatLines(totals);
}

/**
 * Tank01 `playerID` -> Sleeper `player_id`, trimmed to the corpus.
 *
 * A checked-in fixture rather than something derived at test time, because the
 * box score carries no Sleeper id of its own and neither directory is available
 * offline. How it is built, and why it is not the `espn_id` join it obviously
 * should be, is in {@link ./capture.ts}.
 *
 * `name` is Sleeper's own spelling, carried so a failure message can say who it
 * is about — and, at capture time, so the join can be checked rather than
 * trusted.
 */
export type SleeperIdMap = Readonly<
  Record<string, { readonly id: string; readonly name: string }>
>;
