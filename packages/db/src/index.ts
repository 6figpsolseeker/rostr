export type { SqlClient } from "./client.js";

export {
  loadMigrations,
  migrate,
  MigrationError,
  type Migration,
  type MigrateResult,
} from "./migrate.js";

export { withTransaction } from "./transaction.js";

export { loadSportIds, seedSport, SportNotSeededError, type SportIds } from "./sports.js";

export {
  createLeague,
  getLeagueRules,
  LeagueValidationError,
  setRulesUri,
  verifyStoredRules,
  type CreatedLeague,
  type CreateLeagueInput,
  type StoredLeagueRules,
} from "./leagues.js";

export {
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
  addBot,
  getJoinMessage,
  getMembershipProofs,
  JoinError,
  joinLeague,
  type JoinedLeague,
  type JoinLeagueInput,
  type MembershipProof,
} from "./membership.js";
