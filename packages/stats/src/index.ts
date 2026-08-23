export {
  ProviderError,
  type ProviderBoxScore,
  type ProviderGame,
  type ProviderHealth,
  type ProviderInjury,
  type ProviderPlayer,
  type ProviderPlayerProfile,
  type StatsProvider,
} from "./provider.js";

export { Tank01Client, type Tank01Options } from "./tank01/client.js";
export { translateBoxScore, type TranslatedBoxScore } from "./tank01/box-score.js";
export {
  DST_REF_PREFIX,
  Tank01Provider,
  type AdpBoard,
  type AdpEntry,
} from "./tank01/adapter.js";
export {
  isSeasonAggregate,
  parseSeasonProjections,
  type ProviderProjection,
  type RawProjectionsBody,
} from "./tank01/projections.js";
export {
  bucketFieldGoal,
  isBlockedKick,
  isDefensiveReturnTouchdown,
  isExtraPointMade,
  isSpecialTeamsReturnTouchdown,
  isSuccessfulTwoPointConversion,
  parseFieldGoalYards,
  parseStatValue,
  TANK01_DST_MAP,
  TANK01_STAT_MAP,
  TANK01_UNAVAILABLE_STATS,
} from "./tank01/stat-map.js";

/**
 * The second source.
 *
 * `@rostr/db`'s `second-source.ts` translates a Sleeper week with these before
 * writing it, so they have to leave the package. The client goes with them
 * because the caller that fetches a week is the one that ingests it.
 */
export {
  SleeperClient,
  type SleeperClientOptions,
  type SleeperWeek,
} from "./sleeper/client.js";
export {
  sleeperPlayerStats,
  sleeperTeamDefenseStats,
  type SleeperStats,
} from "./sleeper/stats.js";
