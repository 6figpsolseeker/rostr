/**
 * Default full-PPR scoring and league settings for the NFL.
 *
 * These mirror `docs/RULES.md` exactly. A league copies these values at creation
 * — it does not reference them. If this file were ever edited, every league
 * pointing at it would silently change, which is precisely what immutability
 * exists to prevent.
 */

import type {
  DraftRules,
  LeagueRules,
  LeagueSizeRules,
  PotRules,
  RosterRules,
  ScheduleRules,
  ScoringRule,
  SettlementRules,
  TradeRules,
  WaiverRules,
} from "./types.js";

/** Points -> milli-points. Compile-time only; no floats survive into a rule set. */
const pts = (n: number): number => Math.round(n * 1000);

export const NFL_PPR_SCORING: readonly ScoringRule[] = [
  // Passing — 4 per TD, 1 point per 25 yards (0.04/yd)
  { statKey: "pass_td", kind: "LINEAR", milliPointsPerUnit: pts(4) },
  { statKey: "pass_yd", kind: "LINEAR", milliPointsPerUnit: 40 },
  { statKey: "pass_int", kind: "LINEAR", milliPointsPerUnit: pts(-2) },

  // Rushing — 6 per TD, 1 point per 10 yards (0.1/yd)
  { statKey: "rush_td", kind: "LINEAR", milliPointsPerUnit: pts(6) },
  { statKey: "rush_yd", kind: "LINEAR", milliPointsPerUnit: 100 },

  // Receiving — full PPR
  { statKey: "rec_td", kind: "LINEAR", milliPointsPerUnit: pts(6) },
  { statKey: "rec_yd", kind: "LINEAR", milliPointsPerUnit: 100 },
  { statKey: "rec", kind: "LINEAR", milliPointsPerUnit: pts(1) },

  // Misc offense
  { statKey: "fum_lost", kind: "LINEAR", milliPointsPerUnit: pts(-2) },
  { statKey: "two_pt", kind: "LINEAR", milliPointsPerUnit: pts(2) },

  // Kickoff, punt, and blocked-kick returns for a touchdown, scored by the
  // returning player. 6 points, matching ESPN and Sleeper — both treat this as
  // a separate category from the defensive unit's touchdown, and both pay the
  // returner and the D/ST for the same play. That is not double-counting: they
  // are different roster spots, usually owned by different managers.
  { statKey: "ret_td", kind: "LINEAR", milliPointsPerUnit: pts(6) },

  // Kicking — by distance, and a miss costs a point.
  //
  // Misses used to be unpenalised, on the argument that they punish a kicker for
  // his coach's decision to attempt a 55-yarder. ESPN charges -1 regardless of
  // distance, and matching ESPN is the point of this table.
  { statKey: "fg_0_39", kind: "LINEAR", milliPointsPerUnit: pts(3) },
  { statKey: "fg_40_49", kind: "LINEAR", milliPointsPerUnit: pts(4) },
  { statKey: "fg_50_59", kind: "LINEAR", milliPointsPerUnit: pts(5) },
  { statKey: "fg_60_plus", kind: "LINEAR", milliPointsPerUnit: pts(6) },
  { statKey: "fg_missed", kind: "LINEAR", milliPointsPerUnit: pts(-1) },
  { statKey: "xp_made", kind: "LINEAR", milliPointsPerUnit: pts(1) },

  // Defense / special teams
  { statKey: "def_sack", kind: "LINEAR", milliPointsPerUnit: pts(1) },
  { statKey: "def_int", kind: "LINEAR", milliPointsPerUnit: pts(2) },
  { statKey: "def_fum_rec", kind: "LINEAR", milliPointsPerUnit: pts(2) },
  { statKey: "def_safety", kind: "LINEAR", milliPointsPerUnit: pts(2) },
  { statKey: "def_td", kind: "LINEAR", milliPointsPerUnit: pts(6) },
  { statKey: "def_blk_kick", kind: "LINEAR", milliPointsPerUnit: pts(2) },
  // Both defensive tiers are ESPN's, decoded from their own published data
  // rather than from documentation: their scoring API returns values keyed by
  // numeric stat id with no names, so the boundaries were pinned by recomputing
  // every player's weekly total and checking it against the total ESPN itself
  // published. 11,507 player-weeks of the 2025 season reconcile exactly. See
  // `docs/TANK01.md` for the method.
  //
  // The previous points-allowed table paid 10 for a shutout against ESPN's 5 —
  // roughly twice as generous at the top, and short of ESPN's -5 floor at the
  // bottom. It appears to have been transcribed from an out-of-date page.
  {
    statKey: "def_pts_allowed",
    kind: "TIERED",
    tiers: [
      { min: 0, max: 0, milliPoints: pts(5) },
      { min: 1, max: 6, milliPoints: pts(4) },
      { min: 7, max: 13, milliPoints: pts(3) },
      { min: 14, max: 17, milliPoints: pts(1) },
      { min: 18, max: 27, milliPoints: pts(0) },
      { min: 28, max: 34, milliPoints: pts(-1) },
      { min: 35, max: 45, milliPoints: pts(-3) },
      { min: 46, max: null, milliPoints: pts(-5) },
    ],
  },
  {
    statKey: "def_yds_allowed",
    kind: "TIERED",
    tiers: [
      { min: 0, max: 99, milliPoints: pts(5) },
      { min: 100, max: 199, milliPoints: pts(3) },
      { min: 200, max: 299, milliPoints: pts(2) },
      { min: 300, max: 349, milliPoints: pts(0) },
      { min: 350, max: 399, milliPoints: pts(-1) },
      { min: 400, max: 449, milliPoints: pts(-3) },
      { min: 450, max: 499, milliPoints: pts(-5) },
      { min: 500, max: 549, milliPoints: pts(-6) },
      { min: 550, max: null, milliPoints: pts(-7) },
    ],
  },
];

/** QB, RB, RB, WR, WR, TE, FLEX, K, DEF — 9 starters, 5 bench, 14 total. */
export const NFL_PPR_ROSTER: RosterRules = {
  starters: [
    { slotType: "QB", count: 1 },
    { slotType: "RB", count: 2 },
    { slotType: "WR", count: 2 },
    { slotType: "TE", count: 1 },
    { slotType: "FLEX", count: 1 },
    { slotType: "K", count: 1 },
    { slotType: "DEF", count: 1 },
  ],
  benchSlots: 5,
  irSlots: 2,
  lockMode: "PER_PLAYER_KICKOFF",
  autofill: "WEEKLY_PROJECTION",
};

export const NFL_DEFAULT_LEAGUE: LeagueSizeRules = {
  maxTeams: 12,
  minHumans: 2,
  // One, and only to square an odd number of friends. `buildNflPprRules` drops
  // this to zero the moment a league has a pot.
  maxBots: 1,
  visibility: "PRIVATE",
};

export const NFL_DEFAULT_SCHEDULE: ScheduleRules = {
  regularSeasonWeeks: 14,
  playoffWeeks: [15, 16, 17],
  playoffTeams: 6,
  byeSeeds: 2,
  consolationBracket: true,
  // Ends on LOWEST_TEAM_ID: deterministic by design. A coin flip cannot decide a
  // league with money in escrow.
  tiebreakers: ["WIN_PCT", "POINTS_FOR", "HEAD_TO_HEAD", "POINTS_AGAINST", "LOWEST_TEAM_ID"],
};

/** ESPN's defaults, matched deliberately — see `docs/RULES.md` §6. */
export const NFL_DEFAULT_WAIVERS: WaiverRules = {
  system: "ROLLING_PRIORITY",
  waiverPeriodDays: 1,
  timezone: "America/New_York",
  // Unrostered players lock back onto waivers once the week's games are done,
  // giving everyone a full day of blind claims before they resolve.
  weeklyLock: { day: "TUESDAY", hour: 0 },
  processing: { day: "WEDNESDAY", hour: 3 },
  shortTenureHours: 24,
};

export const NFL_DEFAULT_TRADES: TradeRules = {
  enabled: true,
  vetoWindowHours: 48,
  // One third of uninvolved teams — Yahoo's threshold, deliberately harder to
  // trigger than ESPN's majority.
  vetoNumerator: 1,
  vetoDenominator: 3,
  deadlineWeek: 11,
};

export const NFL_DEFAULT_SETTLEMENT: SettlementRules = {
  requiredOracleSources: 2,
  standardFinalizationHours: 48,
  // Seven days: the NFL issues official stat corrections for up to a week, and a
  // reclassified fumble can flip a matchup after it looked settled.
  payingFinalizationHours: 168,
  payingWeeks: [14, 17],
};

/**
 * The default split: champion, runner-up, best regular-season record.
 *
 * **Every prize here is decidable in a league of any size**, and that is the
 * constraint that chose it rather than taste. The payout is frozen and signed
 * before anyone joins, but the bracket's shape is not known until the field
 * locks — so a prize whose existence depends on how many people turn up cannot
 * safely sit in a frozen payout.
 *
 * Consolation and third place are exactly that. A consolation bracket needs at
 * least two teams left over, so it does not exist below eight members with the
 * default six playoff places; a third-place game needs two semifinalists, so it
 * does not exist below four. Paying either meant `championship().complete` could
 * never become true for a small league — the pot simply never settled, and the
 * rules being frozen meant it could not be corrected afterwards.
 *
 * The consolation *bracket* is still played (`schedule.consolationBracket`), so
 * eliminated teams still have fixtures and a reason to set a lineup. It just
 * does not carry a share.
 */
export const NFL_DEFAULT_PAYOUT: PotRules["payout"] = [
  { prize: "CHAMPION", basisPoints: 7000 },
  { prize: "RUNNER_UP", basisPoints: 2000 },
  { prize: "REGULAR_SEASON", basisPoints: 1000 },
];

/**
 * One winner, the whole pot.
 *
 * An option, not the default, and the trade-off is real: `docs/DECISIONS.md`
 * notes that under winner-take-all a 2–9 team in Week 11 is mathematically
 * eliminated and has nothing left to play for. The autofill keeps their lineup
 * legal and their results still move other people's seeds, so the cost is
 * engagement rather than correctness — but a commissioner choosing this should
 * know they are choosing it.
 *
 * Structurally it is the safest payout there is: the champion is decidable in
 * any league with two members.
 */
export const NFL_WINNER_TAKE_ALL_PAYOUT: PotRules["payout"] = [
  { prize: "CHAMPION", basisPoints: 10_000 },
];

/**
 * 1%, taken once from the pot at settlement.
 *
 * For scale: DraftKings and Underdog rake around 10%, and LeagueSafe — the
 * closest thing to a neutral escrow for home leagues — charges 3–5%. At 1% a
 * full 12-team league at the $50 cap pays $6, which is roughly what it costs to
 * run the data feeds for a month across fifteen such leagues.
 *
 * It is a default, not a law: it is frozen per league at creation and members
 * see it before they join.
 */
export const NFL_DEFAULT_FEE_BPS = 100;

export type NflPprOverrides = {
  readonly seasonYear: number;
  readonly draft: DraftRules;
  readonly league?: Partial<LeagueSizeRules>;
  /**
   * The commissioner's trade settings — in practice the deadline, and whether
   * trading happens at all. Set once, at creation, and frozen with everything
   * else; `validateLeagueRules` bounds it to the regular season.
   */
  readonly trades?: Partial<TradeRules>;
  readonly pot?: PotRules | null;
};

/**
 * Build a complete rule set from the defaults.
 *
 * The result is a plain value with no shared references into this module, so a
 * later edit here cannot reach a league that has already been created.
 */
export function buildNflPprRules(overrides: NflPprOverrides): LeagueRules {
  const pot = overrides.pot ?? null;

  return structuredClone({
    schemaVersion: 6,
    sportKey: "nfl",
    seasonYear: overrides.seasonYear,
    scoring: NFL_PPR_SCORING,
    roster: NFL_PPR_ROSTER,
    league: {
      ...NFL_DEFAULT_LEAGUE,
      ...overrides.league,
      // Money and bots do not mix, and the override cannot argue. A bot has no
      // wallet, so a bot champion would leave the largest share with no recipient —
      // and `validateLeagueRules` refuses the combination anyway, so allowing it
      // through here would only produce a league that fails to create.
      ...(pot ? { maxBots: 0 } : {}),
    },
    draft: overrides.draft,
    schedule: NFL_DEFAULT_SCHEDULE,
    waivers: NFL_DEFAULT_WAIVERS,
    trades: { ...NFL_DEFAULT_TRADES, ...overrides.trades },
    pot,
    settlement: NFL_DEFAULT_SETTLEMENT,
  }) as LeagueRules;
}
