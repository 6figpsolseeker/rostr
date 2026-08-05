/**
 * Rule set hashing.
 *
 * The returned hash is what gets written into the on-chain league account, and
 * what a member's join transaction signs over. It is the anchor for every
 * immutability claim this project makes, so it must be reproducible by anyone,
 * on any machine, from the published rule document alone.
 */

import { canonicalHash, canonicalize } from "../canonical.js";
import type { LeagueRules } from "./types.js";

/** Lowercase hex SHA-256 of the canonical encoding of `rules`. */
export function hashLeagueRules(rules: LeagueRules): string {
  return canonicalHash(rules);
}

/**
 * The exact bytes that were hashed.
 *
 * This is the document to pin to IPFS or Arweave — not a pretty-printed copy.
 * Anyone can re-hash it and check it against the chain.
 */
export function encodeLeagueRules(rules: LeagueRules): string {
  return canonicalize(rules);
}

/** Whether a rule set still hashes to an expected value. */
export function verifyLeagueRulesHash(rules: LeagueRules, expectedHash: string): boolean {
  return hashLeagueRules(rules) === expectedHash.toLowerCase();
}
