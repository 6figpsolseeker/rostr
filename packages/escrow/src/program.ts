/**
 * Addresses for the escrow program.
 *
 * Everything here is pure derivation — no RPC, no wallet, no Anchor. That is
 * deliberate: the web app, a server route, and a test all need to agree on
 * where a league lives on-chain, and none of them should have to build a
 * provider to find out.
 *
 * The seeds mirror `programs/rostr-escrow/src/lib.rs` exactly. If they drift,
 * the client addresses an account the program never writes and every call fails
 * in a way that looks like a logic bug rather than a typo. There are tests
 * pinning each one against the program itself.
 */

import { PublicKey } from "@solana/web3.js";

import { ESCROW_IDL } from "./idl.js";

/** Matches `declare_id!` in the program. */
export const ESCROW_PROGRAM_ID = new PublicKey(ESCROW_IDL.address);

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

const LEAGUE_SEED = utf8("league");
const VAULT_SEED = utf8("vault");
const MEMBERSHIP_SEED = utf8("membership");
const SCORES_SEED = utf8("scores");

/**
 * A league's Postgres UUID as the raw 16 bytes the program uses for its seed.
 *
 * The on-chain account is addressed by the same identifier as the database row,
 * so the two point at each other with no lookup table in between. Dashes are
 * formatting; the bytes are what is hashed into the PDA.
 */
export function leagueIdBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/i.test(hex)) {
    throw new Error(`not a UUID: ${uuid}`);
  }

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** The inverse, for reading an on-chain account back to a database id. */
export function leagueIdFromBytes(bytes: Uint8Array | number[]): string {
  const arr = Array.from(bytes);
  if (arr.length !== 16) throw new Error(`league id must be 16 bytes, got ${arr.length}`);

  const hex = arr.map((b) => b.toString(16).padStart(2, "0")).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

/** Where a league's terms live. Seeded by its database id. */
export function leaguePda(leagueId: string): PublicKey {
  return PublicKey.findProgramAddressSync(
    [LEAGUE_SEED, leagueIdBytes(leagueId)],
    ESCROW_PROGRAM_ID,
  )[0];
}

/**
 * The payee roster and the posted results. One per league.
 *
 * Two forms because callers arrive with different things in hand: a route holds
 * the league's uuid, and a helper that has already derived the league PDA should
 * not derive it twice.
 */
export function scoresPdaFor(league: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [SCORES_SEED, league.toBytes()],
    ESCROW_PROGRAM_ID,
  )[0];
}

export function scoresPda(leagueId: string): PublicKey {
  return scoresPdaFor(leaguePda(leagueId));
}

/**
 * Where the pot lives. A token account whose authority is the league PDA, so no
 * key held by any person can move it.
 */
export function vaultPda(league: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([VAULT_SEED, league.toBytes()], ESCROW_PROGRAM_ID)[0];
}

/**
 * One member's place in one league.
 *
 * Seeded by league *and* member, which is why a second join collides with an
 * existing account rather than needing a check the program could forget.
 */
export function membershipPda(league: PublicKey, member: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [MEMBERSHIP_SEED, league.toBytes(), member.toBytes()],
    ESCROW_PROGRAM_ID,
  )[0];
}

/** Every address a league needs, derived in one call. */
export type LeagueAddresses = {
  readonly league: PublicKey;
  readonly vault: PublicKey;
};

export function leagueAddresses(leagueId: string): LeagueAddresses {
  const league = leaguePda(leagueId);
  return { league, vault: vaultPda(league) };
}
