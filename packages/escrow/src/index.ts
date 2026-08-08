/**
 * `@rostr/escrow` — the client half of the escrow program.
 *
 * Addresses and the program's interface, and nothing that needs a network. The
 * web app, a server route, and the program's own tests all have to agree on
 * where a league lives on-chain; this is the one place that answer is written.
 */

export { ESCROW_IDL, type EscrowIdl } from "./idl.js";
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
