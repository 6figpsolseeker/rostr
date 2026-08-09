/**
 * Reading a league back off the chain, and checking it says what we think.
 *
 * This is the half of anchoring that must not be trusted to a browser. A client
 * reports "I anchored it, here is the signature", and a signature proves only
 * that *some* transaction happened. What makes the record a fact is fetching the
 * account and finding our rules hash in it.
 *
 * It lives here rather than in the route deliberately. The route needs a session,
 * a database and an HTTP request to exercise; this needs a connection and a
 * deployed program, which the program test suite already has — so the part where
 * the bugs actually are gets tested against a real chain instead of a mock.
 *
 * The bugs in question are all shape, not logic: 32 raw bytes on-chain versus a
 * 64-character hex string in Postgres, a `number[]` from Anchor versus a
 * `Uint8Array`, and a comparison that quietly succeeds because both sides
 * stringify to `[object Object]`.
 */

import type { Program } from "@coral-xyz/anchor";
import type { Connection, PublicKey } from "@solana/web3.js";

import { leaguePda } from "./program.js";
import type { RostrEscrow } from "./types.js";

/** A league's frozen terms, as they exist on-chain. */
export interface OnChainLeague {
  readonly address: PublicKey;
  /** Lower-case hex, to compare directly against `leagues.rules_hash`. */
  readonly rulesHash: string;
  readonly hasPot: boolean;
  /** Base units as a decimal string. Zero for a free league. */
  readonly buyIn: string;
  readonly tokenMint: string;
  readonly feeBps: number;
  readonly maxTeams: number;
  readonly memberCount: number;
}

/**
 * Bytes to lower-case hex.
 *
 * Anchor hands back a `number[]` for a `[u8; 32]`, Postgres stores `char(64)`.
 * Doing this by hand rather than reaching for Buffer keeps it working in a
 * browser bundle, where Buffer is a polyfill that may or may not be present.
 */
export function bytesToHex(bytes: Uint8Array | readonly number[]): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** The inverse, for handing a stored hash to an instruction. */
export function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error(`not a 32-byte hex hash: ${hex}`);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Read a league's account, or `null` when it does not exist.
 *
 * A missing account is the ordinary case — a league created in the database but
 * not yet anchored — so it is a return value rather than a throw.
 */
export async function fetchOnChainLeague(
  program: Program<RostrEscrow>,
  leagueId: string,
): Promise<OnChainLeague | null> {
  const address = leaguePda(leagueId);

  const account = await program.account["league"]?.fetchNullable(address);
  if (!account) return null;

  const raw = account as {
    rulesHash: number[];
    hasPot: boolean;
    buyIn: { toString(): string };
    tokenMint: PublicKey;
    feeBps: number;
    maxTeams: number;
    memberCount: number;
  };

  return {
    address,
    rulesHash: bytesToHex(raw.rulesHash),
    hasPot: raw.hasPot,
    buyIn: raw.buyIn.toString(),
    tokenMint: raw.tokenMint.toBase58(),
    feeBps: raw.feeBps,
    maxTeams: raw.maxTeams,
    memberCount: raw.memberCount,
  };
}

export type AnchorVerdict =
  | { readonly ok: true; readonly league: OnChainLeague }
  | { readonly ok: false; readonly reason: "NOT_FOUND" }
  | {
      readonly ok: false;
      readonly reason: "HASH_MISMATCH";
      readonly onChain: string;
      readonly expected: string;
    };

/**
 * Confirm a league is anchored, and anchored with **our** rules.
 *
 * The hash comparison is the entire point. Finding an account at the right
 * address proves only that somebody created one; a league is anchored when the
 * document members are about to sign is the document the chain holds.
 *
 * Case-insensitive because the two sides come from different places — Postgres
 * `char(64)` and bytes formatted here — and a mismatch of case would be a
 * spurious failure on identical data.
 */
export async function verifyLeagueAnchor(
  program: Program<RostrEscrow>,
  leagueId: string,
  expectedRulesHash: string,
): Promise<AnchorVerdict> {
  const league = await fetchOnChainLeague(program, leagueId);
  if (!league) return { ok: false, reason: "NOT_FOUND" };

  if (league.rulesHash.toLowerCase() !== expectedRulesHash.toLowerCase()) {
    return {
      ok: false,
      reason: "HASH_MISMATCH",
      onChain: league.rulesHash,
      expected: expectedRulesHash.toLowerCase(),
    };
  }

  return { ok: true, league };
}

/**
 * Which cluster a connection is talking to, as `leagues.chain_cluster` records
 * it.
 *
 * The PDA is byte-identical on every cluster, so "the account exists" is not an
 * answer on its own — a devnet anchor is not an anchor for a mainnet stake.
 * Derived from the endpoint rather than trusted from a caller, because the point
 * of this module is not taking the client's word for anything.
 */
export function clusterOf(connection: Connection): string {
  const endpoint = connection.rpcEndpoint;
  if (endpoint.includes("devnet")) return "devnet";
  if (endpoint.includes("testnet")) return "testnet";
  if (endpoint.includes("localhost") || endpoint.includes("127.0.0.1")) return "localnet";
  return "mainnet-beta";
}
