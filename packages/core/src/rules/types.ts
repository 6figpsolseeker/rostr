/**
 * The league rule set — the structure that gets hashed on-chain and can never
 * change for the life of a league.
 *
 * Two conventions run through everything here:
 *
 *   1. **No fractional numbers.** Scoring is in milli-points (1 point = 1000),
 *      percentages in basis points (100% = 10000), thresholds as explicit
 *      numerator/denominator pairs. Floats can never enter the rule set, so they
 *      can never make two machines disagree about a hash. See `canonical.ts`.
 *
 *   2. **`type`, not `interface`.** Type aliases receive an implicit index
 *      signature, so a `LeagueRules` is assignable to `CanonicalValue` without a
 *      cast. Switching these to interfaces would break hashing at the type level.
 */

/** 1 point, expressed in milli-points. */
export const MILLI_POINTS_PER_POINT = 1000;

/** 100%, expressed in basis points. */
export const BASIS_POINTS_TOTAL = 10_000;

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export type LinearScoringRule = {
  readonly statKey: string;
  readonly kind: "LINEAR";
  /** Milli-points awarded per unit of the stat. May be negative. */
  readonly milliPointsPerUnit: number;
};

export type ScoringTier = {
  /** Inclusive lower bound. */
  readonly min: number;
  /** Inclusive upper bound; `null` means unbounded. */
  readonly max: number | null;
  readonly milliPoints: number;
};

export type TieredScoringRule = {
  readonly statKey: string;
  readonly kind: "TIERED";
  /** Ordered, contiguous, non-overlapping. Validated at league creation. */
  readonly tiers: readonly ScoringTier[];
};

export type ScoringRule = LinearScoringRule | TieredScoringRule;

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------

export type RosterSlotRule = {
  readonly slotType: string;
  readonly count: number;
};

export type RosterRules = {
  /** Starting slots, in display order. */
  readonly starters: readonly RosterSlotRule[];
  readonly benchSlots: number;
  readonly irSlots: number;
  /** Per-player at their game's kickoff, or all slots at the week's first kickoff. */
  readonly lockMode: "PER_PLAYER_KICKOFF" | "FIRST_KICKOFF";
};

// ---------------------------------------------------------------------------
// League
// ---------------------------------------------------------------------------

export type LeagueSizeRules = {
  readonly maxTeams: number;
  readonly minHumans: number;
  readonly botsAllowed: boolean;
  readonly visibility: "PRIVATE" | "PUBLIC";
};

// ---------------------------------------------------------------------------
// Draft
// ---------------------------------------------------------------------------

export type DraftRules = {
  readonly type: "SNAKE";
  readonly mode: "FAST" | "SLOW";
  /** Pick clock. Fast: 90-600. Slow: 3600-86400. Never below 90. */
  readonly pickSeconds: number;
  /** Unix seconds. Fixed at creation so it cannot be moved to disadvantage anyone. */
  readonly scheduledAt: number;
};

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

export type ScheduleRules = {
  readonly regularSeasonWeeks: number;
  /** Ordered playoff weeks, e.g. [15, 16, 17]. */
  readonly playoffWeeks: readonly number[];
  readonly playoffTeams: number;
  /** Top N seeds receive a first-round bye. */
  readonly byeSeeds: number;
  readonly consolationBracket: boolean;
  /**
   * Applied in order. The final entry must be deterministic — no randomness may
   * decide a league with money in it.
   */
  readonly tiebreakers: readonly Tiebreaker[];
};

export type Tiebreaker =
  "WIN_PCT" | "POINTS_FOR" | "HEAD_TO_HEAD" | "POINTS_AGAINST" | "LOWEST_TEAM_ID";

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

export type Weekday =
  "SUNDAY" | "MONDAY" | "TUESDAY" | "WEDNESDAY" | "THURSDAY" | "FRIDAY" | "SATURDAY";

/** A recurring weekly moment, in the league's timezone. */
export type WeeklyMoment = {
  readonly day: Weekday;
  /** Local hour, 0–23. */
  readonly hour: number;
};

/**
 * Waivers and free agency, matching ESPN.
 *
 * Every unrostered player is in one of two states at any moment: **on waivers**,
 * frozen and claimable only by blind claim, or a **free agent**, addable
 * instantly by anyone.
 *
 * The weekly cycle is the point of the system. Every unrostered player returns
 * to waivers after the week's games, so a backup who broke out on Sunday is
 * claimed by priority on Wednesday rather than by whoever refreshes fastest on
 * Sunday night.
 */
export type WaiverRules = {
  readonly system: "ROLLING_PRIORITY";
  /**
   * Days a player sits on waivers before clearing. ESPN's default is 1: a
   * player clears at the first processing run at least this long after landing.
   */
  readonly waiverPeriodDays: number;
  /**
   * IANA timezone the weekly schedule is expressed in.
   *
   * **A timezone, never a UTC offset.** "Wednesday 03:00 ET" is 08:00 UTC in
   * winter and 07:00 UTC in summer, and the NFL season crosses the change in
   * early November — right before the trade deadline. Freezing an offset would
   * silently shift every waiver run by an hour mid-season.
   */
  readonly timezone: string;
  /** When unrostered players return to waivers for the week. */
  readonly weeklyLock: WeeklyMoment;
  /** When claims are resolved. */
  readonly processing: WeeklyMoment;
  /**
   * A player rostered for less than this many hours goes straight to free
   * agency when dropped, rather than to waivers.
   *
   * ESPN's rule, and it exists to stop a manager adding a player, cutting him
   * hours later, and re-adding him to dodge the queue.
   */
  readonly shortTenureHours: number;
};

export type TradeRules = {
  readonly enabled: boolean;
  readonly vetoWindowHours: number;
  /** Fraction of *uninvolved* teams needed to veto, as exact integers. */
  readonly vetoNumerator: number;
  readonly vetoDenominator: number;
  /** Last week trades may execute. */
  readonly deadlineWeek: number;
};

// ---------------------------------------------------------------------------
// Pot
// ---------------------------------------------------------------------------

export type PrizeKey =
  "CHAMPION" | "RUNNER_UP" | "THIRD_PLACE" | "REGULAR_SEASON" | "CONSOLATION";

export type PayoutShare = {
  readonly prize: PrizeKey;
  /** Basis points. All shares must sum to exactly 10000. */
  readonly basisPoints: number;
};

export type PotRules = {
  /** SPL mint address. One token per league — mixed pots are not a pot. */
  readonly tokenMint: string;
  /** Buy-in in the token's base units, as a decimal string (an on-chain u64). */
  readonly buyInBaseUnits: string;
  /** Champion must always hold the largest single share. */
  readonly payout: readonly PayoutShare[];
  /**
   * Unix seconds after which any member may unilaterally withdraw their own
   * stake, regardless of league state. The guarantee that funds can never be
   * permanently stuck.
   */
  readonly refundUnlockAt: number;
};

// ---------------------------------------------------------------------------
// Abandonment
// ---------------------------------------------------------------------------

export type AbandonmentRules = {
  /** Consecutive weeks with an invalid lineup before a team is abandoned. */
  readonly strikesToAbandon: number;
  readonly autolineup: "SEASON_AVERAGE";
  readonly forfeitStakeToChampion: boolean;
};

// ---------------------------------------------------------------------------
// Settlement
// ---------------------------------------------------------------------------

export type SettlementRules = {
  /** Independent providers that must agree before a week finalises. */
  readonly requiredOracleSources: number;
  /** Finalisation delay for weeks that only move standings. */
  readonly standardFinalizationHours: number;
  /**
   * Finalisation delay for weeks that pay out. Must exceed the NFL's official
   * stat-correction window, which runs to seven days.
   */
  readonly payingFinalizationHours: number;
  /** Weeks that trigger a payout, and therefore wait the longer window. */
  readonly payingWeeks: readonly number[];
};

// ---------------------------------------------------------------------------
// The whole thing
// ---------------------------------------------------------------------------

export type LeagueRules = {
  readonly schemaVersion: 1;
  readonly sportKey: string;
  readonly seasonYear: number;
  readonly scoring: readonly ScoringRule[];
  readonly roster: RosterRules;
  readonly league: LeagueSizeRules;
  readonly draft: DraftRules;
  readonly schedule: ScheduleRules;
  readonly waivers: WaiverRules;
  readonly trades: TradeRules;
  /** `null` when the league plays for nothing. */
  readonly pot: PotRules | null;
  readonly abandonment: AbandonmentRules;
  readonly settlement: SettlementRules;
};
