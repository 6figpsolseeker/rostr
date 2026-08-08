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
  finalizationHours,
  generateSeasonSchedule,
  loadScheduledWeek,
  loadWeekResults,
  persistSchedule,
  resolveLeagueWeek,
  WeekError,
  type ResolveWeekOutcome,
} from "./week.js";

export {
  autoFillLineup,
  ensureLineups,
  LineupError,
  loadLineup,
  loadRosterForWeek,
  loadWeekLineups,
  loadWeekStats,
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
  addBot,
  getJoinMessage,
  getMembershipProofs,
  JoinError,
  joinLeague,
  teamForUser,
  type JoinedLeague,
  type JoinLeagueInput,
  type MembershipProof,
} from "./membership.js";
