/**
 * Pinning a league's rule document.
 *
 * The one operation that matters: pin the canonical bytes, then read them back
 * and confirm they still hash to what was signed. Only then is the URI safe to
 * record.
 *
 * Skipping the read-back would allow a `rules_uri` that resolves to something
 * other than the hashed document — worse than having no URI at all, because it
 * looks verified.
 */

import type { LeagueRules } from "@rostr/core";
import { encodeLeagueRules, hashLeagueRules, sha256Hex } from "@rostr/core";
import { PinVerificationError } from "./types.js";
import type { PinningService, PinResult } from "./types.js";

export interface PinnedRules extends PinResult {
  readonly hash: string;
  readonly canonical: string;
}

/**
 * Pin a rule set and verify the round trip.
 *
 * @throws {PinVerificationError} if what comes back is not byte-identical to
 * what went in.
 */
export async function pinLeagueRules(
  service: PinningService,
  rules: LeagueRules,
  name = "rules.json",
): Promise<PinnedRules> {
  const canonical = encodeLeagueRules(rules);
  const hash = hashLeagueRules(rules);

  const result = await service.pin(canonical, name);

  // Hash the retrieved bytes directly. Re-parsing and re-encoding would hide
  // exactly the corruption this check exists to catch.
  const retrieved = await service.fetch(result.uri);
  const retrievedHash = sha256Hex(retrieved);

  if (retrievedHash !== hash) {
    throw new PinVerificationError(hash, retrievedHash, result.uri);
  }

  return { ...result, hash, canonical };
}

/**
 * Check that a URI still resolves to the document matching `expectedHash`.
 *
 * Worth running periodically: pinning services drop content, and a league whose
 * rules cannot be retrieved has lost the thing its on-chain hash points at.
 */
export async function verifyPinnedRules(
  service: PinningService,
  uri: string,
  expectedHash: string,
): Promise<boolean> {
  try {
    const content = await service.fetch(uri);
    return sha256Hex(content) === expectedHash.toLowerCase();
  } catch {
    return false;
  }
}
