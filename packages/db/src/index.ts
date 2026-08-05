export type { SqlClient } from "./client.js";

// Migrations are deliberately NOT exported here. `migrate.ts` reads SQL files
// from disk, which a bundler cannot statically analyse — importing it from an
// app entry point breaks the build. It lives at `@rostr/db/migrate`, for CLI and
// setup code only.

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
