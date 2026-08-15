export type { SqlClient } from "./client.js";

// Migrations are deliberately NOT exported here. `migrate.ts` reads SQL files
// from disk, which a bundler cannot statically analyse — importing it from an
// app entry point breaks the build. It lives at `@rostr/db/migrate`, for CLI and
// setup code only.

export { withTransaction } from "./transaction.js";

export { loadSportIds, seedSport, SportNotSeededError, type SportIds } from "./sports.js";

export {
  createLeague,
  getChainState,
  getLeagueRules,
  LeagueValidationError,
  recordChainAnchor,
  setRulesUri,
  verifyStoredRules,
  type ChainAnchor,
  type CreatedLeague,
  type CreateLeagueInput,
  type LeagueChainState,
  type StoredLeagueRules,
} from "./leagues.js";

export {
  addFreeAgent,
  availabilityOf,
  availablePlayers,
  cancelClaim,
  dropPlayer,
  leaguesDueForWaivers,
  loadWaiverPriority,
  nextWaiverRun,
  pendingClaims,
  processWaivers,
  seedWaiverPriority,
  submitClaim,
  WaiverError,
  type AddInput,
  type Availability,
  type WaiverRunOutcome,
} from "./waivers.js";

export {
  getAutofillEnabled,
  loadAverages,
  loadProjectedPoints,
  setAutofillEnabled,
} from "./lineups.js";

export {
  advancePlayoffs,
  championship,
  enterPlayoffs,
  leaguesInPlayoffs,
  PlayoffError,
  playoffState,
  type AdvanceOutcome,
  type BracketState,
  type Championship,
  type PlayoffState,
} from "./playoffs.js";

export {
  loadTeamMatchup,
  loadWeekMatchups,
  MatchupError,
  type MatchupSide,
  type MatchupView,
  type PlayerGameState,
  type PlayerLine,
} from "./matchup.js";

export {
  currentWeek,
  finalizationHours,
  generateSeasonSchedule,
  loadScheduledWeek,
  loadWeekResults,
  type MatchupPhase,
  persistSchedule,
  resolveLeagueWeek,
  resolveLeagueWeeksThrough,
  transactionWeek,
  WeekError,
  type ResolveWeekOutcome,
} from "./week.js";

export {
  autoFillLineup,
  ensureLineups,
  LineupError,
  loadLineup,
  loadKickoffs,
  loadRosterForWeek,
  loadWeekLineups,
  loadWeekStats,
  PRIMARY_PROJECTION_SOURCE,
  PRIMARY_STAT_SOURCE,
  setLineup,
  type SetLineupInput,
} from "./lineups.js";

export {
  consumeAll,
  consumeRateLimit,
  hashedIp,
  purgeIdleRateLimits,
  SIGN_IN_PER_EMAIL,
  SIGN_IN_PER_IP,
  WALLET_CHALLENGE_PER_IP,
  WALLET_CHALLENGE_PER_USER,
  type RateLimitResult,
  type RateLimitRule,
} from "./rate-limit.js";

export {
  CHALLENGE_TTL_MS,
  createSession,
  issueWalletChallenge,
  linkWalletWithSignature,
  purgeExpiredSessions,
  resolveSession,
  revokeAllSessions,
  revokeSession,
  SESSION_TTL_MS,
  SessionError,
  type Session,
  type WalletChallenge,
} from "./sessions.js";

export {
  beginEmailSignIn,
  createUser,
  findUserByEmail,
  getUser,
  getWallets,
  IdentityError,
  issueVerificationToken,
  linkWallet,
  verifyEmail,
  VERIFICATION_TTL_MS,
  type User,
  type VerificationToken,
  type Wallet,
} from "./identity.js";

export {
  CORRECTION_WINDOW_HOURS,
  FAILED_RETRY_MINUTES,
  FINAL_RECHECK_HOURS,
  syncBoxScores,
  type BoxScoreSyncResult,
} from "./box-scores.js";

export {
  loadDraftBoard,
  loadProjections,
  syncByeWeeks,
  syncGames,
  syncPlayers,
  syncProjections,
  syncRankings,
  type AdpCapableProvider,
  type DraftBoardEntry,
  type ProjectionCapableProvider,
  type SyncResult,
} from "./sync.js";

export {
  catchUpExpiredPicks,
  createDraftRecord,
  draftProgress,
  DraftPersistenceError,
  draftsWithExpiredPicks,
  drawDraftOrder,
  getQueue,
  isCurrentPickExpired,
  loadDraft,
  loadQueues,
  pauseDraft,
  recordPick,
  setQueue,
  startDraft,
  verifyDraftOrder,
  type CreateDraftInput,
  type DraftProgress,
  type DraftRecord,
  type DrawOrderInput,
  type OrderDraw,
  type RecordedPick,
  type RecordPickInput,
} from "./draft.js";

export {
  BeaconError,
  FixedBeacon,
  SolanaBeacon,
  type DrawnBlock,
  type RandomnessBeacon,
  type SolanaBeaconOptions,
} from "./randomness.js";

export {
  acceptTrade,
  declineTrade,
  leaguesWithDueTrades,
  listTrades,
  lockedByTrade,
  proposeTrade,
  resolveDueTrades,
  TradeError,
  vetoTrade,
  withdrawTrade,
  type ProposeTradeInput,
  type DueTradesOutcome,
  type TradeResolution,
  type TradeState,
  type TradeSummary,
} from "./trades.js";

export {
  addBot,
  getJoinMessage,
  getMembershipProofs,
  getOnChainDeposit,
  getOnChainJoin,
  getOnChainRefund,
  JoinError,
  joinLeague,
  memberWallet,
  recordOnChainDeposit,
  recordOnChainJoin,
  recordOnChainRefund,
  removeBot,
  teamForUser,
  type JoinedLeague,
  type JoinLeagueInput,
  type MembershipProof,
  type OnChainJoin,
  type OnChainStake,
} from "./membership.js";
