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

/**
 * Buy-in bounds, in a six-decimal stablecoin's base units: $5 to $50.
 *
 * A range, not a price — a league stakes whatever it likes between them. The
 * ceiling caps what any single league can lose to a bug in an unaudited escrow;
 * the floor exists because a pot has fixed costs a stake does not scale with,
 * so below a few dollars the transfers cost more than the prize.
 *
 * Mirrored in `programs/rostr-escrow/src/lib.rs`, which is where they bind.
 * These exist so a league creator sees a sentence instead of a program error.
 */
export const MIN_BUY_IN_BASE_UNITS = 5_000_000;
export const MAX_BUY_IN_BASE_UNITS = 50_000_000;

/**
 * Ceiling on the protocol fee, in basis points. 5%.
 *
 * Not the fee itself — that is per league and frozen at creation. This is the
 * highest a league may ever be created with, so the ceiling is visible in the
 * open-source rule schema rather than being whatever we decide to charge on a
 * given day. The default is 1%; see `NFL_DEFAULT_FEE_BPS`.
 */
export const MAX_FEE_BPS = 500;

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
  /**
   * How a slot the manager left empty gets filled at lock.
   *
   * `WEEKLY_PROJECTION` — the highest projected scorer eligible for the slot,
   * from the provider's projection for that week. `SEASON_AVERAGE` — the
   * highest season-to-date average. Ties break on ascending player ID in both,
   * because at that point every real criterion has come up equal and all that
   * matters is that two machines agree.
   *
   * **`WEEKLY_PROJECTION` falls back to `SEASON_AVERAGE` per player**, not per
   * league: a rookie with no projection, or a week the provider has not
   * published yet, must not stop the rest of the lineup being filled well. The
   * projection actually used is recorded with the lineup, so the choice stays
   * reproducible by anyone — which is the property that matters, since these
   * results move other people's playoff seeds.
   *
   * This is a *decision*, not a fact, and that is why a projection is allowed to
   * decide it. Facts — did he score? — go through the two-source oracle gate in
   * `SettlementRules`, because two providers can disagree about what happened.
   * Projections are opinions and could never pass that gate; but nobody demands
   * two sources agree on a manager's start/sit call either, and this is standing
   * in for exactly that.
   */
  readonly autofill: "WEEKLY_PROJECTION" | "SEASON_AVERAGE";
};

// ---------------------------------------------------------------------------
// League
// ---------------------------------------------------------------------------

export type LeagueSizeRules = {
  readonly maxTeams: number;
  readonly minHumans: number;
  /**
   * How many bots this league may hold. **Zero in any league with a pot.**
   *
   * A number rather than a boolean, because "allowed" and "how many" are the
   * same fact and two fields encoding one fact can disagree.
   *
   * A bot exists for one reason: an odd number of friends. Five people either
   * play with three dead weeks each — the schedule gives somebody a bye every
   * week — or add one predictable opponent. One is enough for that; more is a
   * different game.
   *
   * **Zero when there is money.** A bot has no wallet and pays no buy-in, so a
   * bot that won a pot league would leave the champion's 60% with nowhere to go.
   * Barring them outright is simpler than every rule that tries to handle it,
   * and it is the kind of guarantee a member should be able to read before they
   * sign — which is why it lives here, in the frozen rules, rather than in a
   * server-side check nobody can verify.
   */
  readonly maxBots: number;
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
  /**
   * Protocol fee in basis points, taken **once, at settlement**, from the pot
   * before the payout shares are applied.
   *
   * It lives in the hashed rule set rather than in our configuration for the
   * same reason everything else here does: a fee we could change later would
   * make "no administrator can rewrite the rules" untrue of the one party with
   * the most to gain. Members see it before they join and sign it with the rest.
   *
   * **The timelock refund is never charged.** Withdrawing your own stake under
   * `refundUnlockAt` returns it in full — an escape hatch that costs money is a
   * weaker guarantee, and that guarantee is the reason the escrow is shippable
   * before it is audited.
   */
  readonly feeBps: number;
  /** Where the fee is paid. Frozen at creation like everything else. */
  readonly feeRecipient: string;
};

// ---------------------------------------------------------------------------
// Abandonment
// ---------------------------------------------------------------------------

/**
 * Abandonment was removed in schema 4, and it is worth recording why here rather
 * than only in a commit nobody will read.
 *
 * The rule counted consecutive weeks with an *invalid* lineup, and it could
 * never fire: the autofill runs before a week is scored, so a lineup is never
 * invalid at the moment the count would happen. `teams.strikes` existed and
 * nothing ever incremented it.
 *
 * It could have been given a workable trigger. It was dropped instead, because
 * the honest version is worse than nothing: a manager who stops setting lineups
 * is not defrauding anyone, and taking their stake for inattention is a rule
 * people would only discover by losing money to it. The autofill already keeps
 * their team competitive, so the league is not harmed.
 *
 * The practical win is that it deletes a whole instruction from the escrow —
 * D7, "abandonment forfeit to champion", which would have moved one member's
 * stake to another based on a strike count, in code shipping without a
 * commercial audit. Deleting a path that moves money beats hardening one.
 */

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
  /**
   * 1 → 2 added `pot.feeBps` and `pot.feeRecipient`.
   * 2 → 3 replaced `league.botsAllowed` with `league.maxBots`.
   * 3 → 4 removed `abandonment` and added `roster.autofill`.
   *
   * Bumping this is the honest way to change the rule schema: it changes the
   * canonical encoding and therefore every hash, so the golden fixture in
   * `rules.test.ts` moves *deliberately* rather than being edited to make a
   * failing test pass. Safe to do here only because no league exists yet. Once
   * one does, a schema change means supporting both versions — the rules of a
   * created league can never be re-encoded.
   */
  readonly schemaVersion: 4;
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
  readonly settlement: SettlementRules;
};
