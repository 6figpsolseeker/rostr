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
  MILLI_POINTS_PER_POINT,
  type AbandonmentRules,
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
} from "./rules/types.js";

export {
  buildNflPprRules,
  NFL_DEFAULT_ABANDONMENT,
  NFL_DEFAULT_LEAGUE,
  NFL_DEFAULT_PAYOUT,
  NFL_DEFAULT_SCHEDULE,
  NFL_DEFAULT_SETTLEMENT,
  NFL_DEFAULT_TRADES,
  NFL_DEFAULT_WAIVERS,
  NFL_PPR_ROSTER,
  NFL_PPR_SCORING,
  type NflPprOverrides,
} from "./rules/nfl-ppr.js";

export { encodeLeagueRules, hashLeagueRules, verifyLeagueRulesHash } from "./rules/hash.js";
export { validateLeagueRules } from "./rules/validate.js";

export {
  buildJoinMessage,
  isValidWalletAddress,
  verifyJoinSignature,
  type JoinMessageInput,
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
