import "server-only";

/**
 * Publishing a league's rule document.
 *
 * `createLeague` freezes the rules and hashes them; this puts the bytes
 * somewhere a member can fetch and re-hash them. The hash is the guarantee —
 * `rules_uri` is only the address — which is why nothing here is allowed to
 * cost a league.
 *
 * **A failed pin never fails the request, and that is forced rather than
 * chosen.** `league_rules` refuses its own DELETE and holds the `leagues` row
 * via `ON DELETE RESTRICT`, so once `createLeague` commits the row cannot be
 * removed by anything. There is no "undo the league and report an error" branch
 * available to write. The only reachable outcomes are a league with a URI and a
 * league without one, so this returns which of those happened and the caller
 * carries on either way.
 *
 * `leagues.rules_uri IS NULL` is therefore an ordinary state, and `0044`'s
 * column comment says so. A member may join a league whose rules are not yet
 * published — decided by the owner on 2026-08-30. The rules are still frozen,
 * still hashed, still rendered in full above the join control from the database,
 * and still anchored on-chain; publication makes them independently verifiable
 * rather than making them exist.
 */

import type { LeagueRules } from "@rostr/core";
import type { SqlClient } from "@rostr/db";
import { setRulesUri } from "@rostr/db";
import { PinataPinningService, pinLeagueRules } from "@rostr/pinning";
import type { PinningService } from "@rostr/pinning";

/**
 * How long the whole publish may take before it is abandoned.
 *
 * `pinLeagueRules` is two network round trips — the upload, then the read-back
 * that proves the bytes survived — and this sits inside a user-facing POST that
 * has already committed a league. An unbounded wait would hold that response
 * open behind somebody else's outage for as long as it lasted.
 *
 * Abandoning is safe in a way that is worth stating: the upload may well have
 * succeeded, and a later retry re-pins the identical bytes to the identical CID,
 * so a timeout costs a duplicate request and never a wrong address.
 */
const PUBLISH_TIMEOUT_MS = 15_000;

/** What happened to a league's rule document. */
export type PublishOutcome =
  /** Pinned, read back, verified, and recorded. */
  | { readonly published: true; readonly uri: string }
  /**
   * Not published. The league exists and is usable; the document can be pinned
   * later, and `leagues_unpinned_idx` in `0044` is what finds these.
   *
   * `reason` is for the server log and for the operator, never for the member —
   * it names an outage or a missing credential, neither of which they can act
   * on.
   */
  | { readonly published: false; readonly reason: string };

/**
 * The configured pinning service, or `null` if there is none.
 *
 * Unconfigured is a real deployment state rather than an error: pinning is
 * listed in `docs/SETUP-REQUIRED.md` and a local checkout has no key. Returning
 * `null` lets league creation work untouched on a fresh clone, at the cost of an
 * unpublished document — which is exactly the trade the rest of this file makes
 * for a Pinata outage, so it needs no separate branch.
 */
export function pinningService(): PinningService | null {
  const jwt = process.env.PINATA_JWT;
  if (!jwt) return null;

  const gateway = process.env.PINATA_GATEWAY;
  return new PinataPinningService({
    jwt,
    // Only pass it when set, so the service keeps its own default rather than
    // receiving an empty string. `exactOptionalPropertyTypes` is on.
    ...(gateway ? { gateway } : {}),
    fetchImpl: (input, init) =>
      fetch(input, { ...init, signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS) }),
  });
}

/**
 * Pin a league's rules and record where they went. Never throws.
 *
 * Ordering is the whole of it: **pin first, record second**, and record only
 * through `setRulesUri`, which swaps on the league's own `rules_hash`. So the
 * column is written only from a document that was uploaded, fetched back, and
 * confirmed byte-identical to what was hashed — `pinLeagueRules` does that
 * check and throws otherwise. A URI that resolves to the wrong document is
 * worse than no URI at all, because it looks verified.
 *
 * @param rules The frozen rule set. Passed rather than re-read so the bytes
 * pinned are derived from the same object `createLeague` hashed.
 */
export async function publishLeagueRules(
  db: SqlClient,
  leagueId: string,
  rules: LeagueRules,
  service: PinningService | null = pinningService(),
): Promise<PublishOutcome> {
  if (!service) {
    return { published: false, reason: "No pinning service is configured (PINATA_JWT)" };
  }

  try {
    const pinned = await pinLeagueRules(service, rules, `rules-${leagueId}.json`);

    // False here is not an outage. It means the league's own hash is not the
    // hash of what was just pinned — a mixup rather than a failure — so it must
    // never be reported as "try again".
    const recorded = await setRulesUri(db, leagueId, pinned);
    if (!recorded) {
      return {
        published: false,
        reason:
          `Pinned ${pinned.uri}, but league ${leagueId} did not accept it: its ` +
          `rules hash to something other than ${pinned.hash}, or it is already ` +
          `pinned elsewhere. This is a mixup, not an outage — do not retry blindly.`,
      };
    }

    return { published: true, uri: pinned.uri };
  } catch (error) {
    // Deliberately broad. Every failure here has the same remedy — the league
    // stands, unpublished, and is pinned later — so distinguishing a timeout
    // from a refused upload from a failed read-back would change nothing the
    // caller does. The message keeps the distinction for whoever reads the log.
    return {
      published: false,
      reason: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    };
  }
}
