/**
 * `@rostr/escrow` — the client half of the escrow program.
 *
 * Addresses and the program's interface, and nothing that needs a network. The
 * web app, a server route, and the program's own tests all have to agree on
 * where a league lives on-chain; this is the one place that answer is written.
 */

export { ESCROW_IDL, type EscrowIdl } from "./idl.js";
export {
  GENESIS_HASHES,
  POT_MINTS,
  clusterFromGenesisHash,
  clusterMismatch,
  parseCluster,
  potMintFor,
  resolveCluster,
  type Cluster,
} from "./cluster.js";
export {
  IncompatibleLeagueAccountError,
  anchorTermMismatches,
  bytesToHex,
  clusterOf,
  expectedTermsFromRules,
  fetchOnChainLeague,
  hexToBytes,
  readMembership,
  verifyLeagueAnchor,
  verifyOnChainDeposit,
  verifyOnChainJoin,
  verifyOnChainRefund,
  verifyOnChainSeasonStart,
  type AnchorVerdict,
  type DepositVerdict,
  type ExpectedTerms,
  type JoinVerdict,
  type OnChainLeague,
  type OnChainMembership,
  type RefundVerdict,
  type RulesLikeTerms,
  type SeasonStartVerdict,
} from "./verify.js";
export {
  joinPlan,
  type JoinPlan,
  type JoinPlanInput,
  type MembershipState,
} from "./join-plan.js";
export {
  SETTLEMENT_PREFIXES,
  instructionNames,
  potDepositGate,
  settlementShipped,
  type DepositGate,
  type IdlShape,
} from "./settlement.js";
export {
  PRIZE_ORDER,
  depositIx,
  escrowProgram,
  initializeFreeLeagueIx,
  initializeLeagueIx,
  joinLeagueIx,
  payoutArray,
  refundStakeIx,
  initializeScoresIx,
  startSeasonIx,
  type DepositParams,
  type InitializeFreeLeagueParams,
  type InitializeLeagueParams,
  type JoinLeagueParams,
  type PrizeKey,
  type RefundParams,
  type InitializeScoresParams,
  type StartSeasonParams,
} from "./instructions.js";
export {
  START_GRACE_SECONDS,
  seasonStartState,
  startDeadlineFor,
  type SeasonStartInput,
  type SeasonStartState,
} from "./start.js";
export {
  expectedScoreTerms,
  fetchOnChainScores,
  scoresTermMismatches,
  TIEBREAKER_DISCRIMINANTS,
  uuidToHex,
  type ExpectedScoreTerms,
  type OnChainRosterEntry,
  type OnChainScores,
  type ScoreTermRules,
} from "./scores.js";
export {
  ESCROW_PROGRAM_ID,
  leagueAddresses,
  leagueIdBytes,
  leagueIdFromBytes,
  leaguePda,
  membershipPda,
  scoresPda,
  scoresPdaFor,
  vaultPda,
  type LeagueAddresses,
} from "./program.js";
