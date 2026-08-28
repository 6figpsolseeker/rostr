export {
  canonicalize,
  canonicalHash,
  sha256Hex,
  CanonicalEncodingError,
  type CanonicalValue,
} from "./canonical.js";

export {
  type PositionDef,
  type SlotTypeDef,
  type SportDef,
  type StatKeyDef,
  type StatKind,
  positionsByKey,
  slotTypesByKey,
  statKeysByKey,
  validateSport,
} from "./sports/types.js";

export { NFL, NFL_POSITIONS, NFL_SLOT_TYPES, NFL_STAT_KEYS } from "./sports/nfl.js";

export {
  BASIS_POINTS_TOTAL,
  MAX_BUY_IN_BASE_UNITS,
  MAX_FEE_BPS,
  MILLI_POINTS_PER_POINT,
  MIN_BUY_IN_BASE_UNITS,
  type DraftRules,
  type LeagueRules,
  type LeagueSizeRules,
  type LinearScoringRule,
  type PayoutShare,
  type PotRules,
  type PrizeKey,
  type RosterRules,
  type RosterSlotRule,
  type ScheduleRules,
  type ScoringRule,
  type ScoringTier,
  type SettlementRules,
  type Tiebreaker,
  type TieredScoringRule,
  type TradeRules,
  type WaiverRules,
  type Weekday,
  type WeeklyMoment,
} from "./rules/types.js";

export {
  buildNflPprRules,
  NFL_DEFAULT_FEE_BPS,
  NFL_DEFAULT_LEAGUE,
  NFL_DEFAULT_PAYOUT,
  NFL_WINNER_TAKE_ALL_PAYOUT,
  NFL_DEFAULT_SCHEDULE,
  NFL_DEFAULT_SETTLEMENT,
  NFL_DEFAULT_TRADES,
  NFL_DEFAULT_WAIVERS,
  NFL_PPR_ROSTER,
  NFL_PPR_SCORING,
  type NflPprOverrides,
} from "./rules/nfl-ppr.js";

export { encodeLeagueRules, hashLeagueRules, verifyLeagueRulesHash } from "./rules/hash.js";
export {
  draftDateProblem,
  earliestRefundUnlock,
  MAX_TEAMS_PER_LEAGUE,
  MIN_DRAFT_LEAD_SECONDS,
  latestRefundUnlock,
  validateLeagueRules,
} from "./rules/validate.js";

export {
  buildJoinMessage,
  buildWalletLinkMessage,
  buildWalletSignInMessage,
  isValidWalletAddress,
  verifyJoinSignature,
  verifyWalletLinkSignature,
  verifyWalletSignInSignature,
  type WalletSignInMessageInput,
  type JoinMessageInput,
  type WalletLinkMessageInput,
} from "./signing.js";

export {
  compareScores,
  formatPoints,
  indexScoringRules,
  scorePlayer,
  scoreTeamWeek,
  scoreTeamWeekWithRules,
  ScoringError,
  type LineupEntry,
  type PlayerScore,
  type StatLine,
  type TeamWeekScore,
} from "./scoring/engine.js";

export { SCORING_FIXTURES, type ScoringFixture } from "./scoring/fixtures.js";

export {
  fullDraftSequence,
  generateDraftOrder,
  pickPosition,
  teamOnClock,
  totalPicks,
  type PickPosition,
} from "./draft/order.js";

export {
  buildRosterShape,
  canDraft,
  countAtPosition,
  defaultPositionCaps,
  isAtPositionCap,
  startersFilled,
  unfilledStarterSlots,
  wouldStrandStarters,
  type DraftablePlayer,
  type RosterMember,
  type IllegalPickReason,
  type PickLegality,
  type RosterShape,
  type StartingSlot,
} from "./draft/roster.js";

export {
  deriveOrderSeed,
  explainOrderDraw,
  type OrderRandomness,
  type OrderSeedInput,
} from "./draft/seed.js";

export {
  autoPick,
  pruneQueue,
  type AutoPickContext,
  type AutoPickResult,
  type AutoPickSource,
} from "./draft/autopick.js";

export {
  availabilityAt,
  everyoneIsOnWaivers,
  dropDestination,
  latestWeekly,
  nextProcessingAt,
  nextWeekly,
  nextWeeklyLockAt,
  waiverClearsAt,
  WaiverScheduleError,
  type DropDestination,
  type PlayerAvailability,
} from "./waivers/schedule.js";

export {
  initialWaiverPriority,
  resolveWaiverClaims,
  type ClaimFailure,
  type ClaimOutcome,
  type ResolveInput,
  type WaiverClaim,
  type WaiverResolution,
} from "./waivers/claims.js";

export {
  byeCountsAreBalanced,
  everyTeamPlaysOncePerWeek,
  generateSchedule,
  matchupsForWeek,
  meetingCounts,
  opponentOf,
  ScheduleError,
  type ScheduledMatchup,
} from "./season/schedule.js";

export {
  autolineup,
  autolineupChoices,
  type AutolineupChoice,
  type RunnerUpReason,
  rankingValue,
  seasonAverage,
  type AutofillMode,
  type AutolineupCandidate,
  type AutolineupInput,
} from "./season/autolineup.js";

export {
  lineupIsFullyLocked,
  lockedAssignments,
  slotIsLocked,
  slotLocksAt,
  type KickoffTimes,
  startingSlots,
  validateLineup,
  type LineupAssignment,
  type LineupPlayer,
  type LineupProblem,
  type LineupProblemCode,
  type ValidateLineupInput,
} from "./season/lineup.js";

export {
  gameAvailability,
  type GameAvailability,
  type GameAvailabilityInput,
} from "./season/availability.js";

export {
  BracketError,
  buildBracket,
  thirdPlaceWinner,
  type Bracket,
  type BracketEntrant,
  type BracketGame,
  type BracketRound,
  type BuildBracketInput,
} from "./season/bracket.js";

export {
  computeRecords,
  computeStandings,
  consolationField,
  playoffField,
  StandingsError,
  winPercentageBasisPoints,
  type MatchupResult,
  type StandingsRow,
  type TeamRecord,
} from "./season/standings.js";

export {
  BENCH_SLOT,
  ResultsError,
  resolveMatchups,
  resolveWeek,
  scoreTeamLineup,
  scoreWeek,
  winnerOf,
  type StatsByPlayer,
  type TeamLineup,
} from "./season/results.js";

export {
  isVetoed,
  pastTradeDeadline,
  tradeBlockedBecause,
  vetoWindowEndsAt,
  vetoWindowHasClosed,
  vetoesRequired,
  type TradeBlock,
} from "./trades/veto.js";

export {
  createDraft,
  currentPickNumber,
  currentTeam,
  draftedPlayerIds,
  DraftError,
  isComplete,
  isPickExpired,
  makeAutoPick,
  makePick,
  pickDeadline,
  picksRemainingAfter,
  pickWouldStrandStarters,
  rosterFor,
  secondsRemaining,
  type AutoPickInput,
  type DraftErrorCode,
  type DraftPick,
  type DraftState,
  type MakePickInput,
} from "./draft/state.js";

export {
  countedRosterSize,
  projectedRosterSize,
  reservedByTrades,
  rosterOverage,
  irExemptCount,
  irExemptOnRoster,
  MAY_STILL_PLAY,
  isIrEligible,
  refuseIrPlacement,
  type CommittedTrade,
  type IrPlacementRefusal,
  type RosterOverage,
  type IrRosterEntry,
} from "./season/injured-reserve.js";
