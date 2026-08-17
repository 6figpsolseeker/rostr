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
  type AnchorVerdict,
  type DepositVerdict,
  type ExpectedTerms,
  type JoinVerdict,
  type OnChainLeague,
  type OnChainMembership,
  type RefundVerdict,
  type RulesLikeTerms,
} from "./verify.js";
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
  startSeasonIx,
  type DepositParams,
  type InitializeFreeLeagueParams,
  type InitializeLeagueParams,
  type JoinLeagueParams,
  type PrizeKey,
  type RefundParams,
  type StartSeasonParams,
} from "./instructions.js";
export { START_GRACE_SECONDS, startDeadlineFor } from "./start.js";
export {
  ESCROW_PROGRAM_ID,
  leagueAddresses,
  leagueIdBytes,
  leagueIdFromBytes,
  leaguePda,
  membershipPda,
  vaultPda,
  type LeagueAddresses,
} from "./program.js";
