export {
  ProviderError,
  type ProviderBoxScore,
  type ProviderGame,
  type ProviderHealth,
  type ProviderInjury,
  type ProviderPlayer,
  type StatsProvider,
} from "./provider.js";

export { Tank01Client, type Tank01Options } from "./tank01/client.js";
export {
  bucketFieldGoal,
  isTwoPointConversion,
  parseFieldGoalYards,
  parseStatValue,
  TANK01_DST_MAP,
  TANK01_STAT_MAP,
  TANK01_UNAVAILABLE_STATS,
  TWO_POINT_SCORE_TYPES,
} from "./tank01/stat-map.js";
