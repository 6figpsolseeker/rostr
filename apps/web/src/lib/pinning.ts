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
 * via `ON DELETE RESTRICT`, so once `createLeague` commits no code path here can
 * remove the row — `0019`'s own closing note records the floor honestly, that a
 * migration or whoever owns the tables can still drop a trigger. There is no
 * "undo the league and report an error" branch available to write. The only
 * reachable outcomes are a league with a URI and a league without one, so this
 * returns which of those happened and the caller carries on either way.
 *
 * `leagues.rules_uri IS NULL` is therefore an ordinary state, and `0044`'s
 * column comment says so. A member may join a league whose rules are not yet
 * published — decided by the owner on 2026-08-30. The rules are still frozen,
 * still hashed, still rendered in full above the join control from the database,
 * and still anchored on-chain **before anyone can join** — anchoring is a
 * separate action the commissioner signs, so a league is unanchored at the
 * moment this runs and `joinLeague` is what refuses until it is not.
 *
 * **What publication adds is an independent copy, not verifiability.** A member
 * can already re-encode the rules `GET /api/leagues/[id]` returns, hash them, and
 * compare against the chain — the encoder is deterministic and open source, so a
 * lying server is catchable without IPFS. What a pinned document survives is
 * *us*: this app being down, or the row being gone.
 */

import type { LeagueRules } from "@rostr/core";
import type { SqlClient } from "@rostr/db";
import { setRulesUri } from "@rostr/db";
import { PinataPinningService, pinLeagueRules } from "@rostr/pinning";
import type { PinningService } from "@rostr/pinning";

/**
 * How long the whole publish may take before it is abandoned.
 *
 * **One deadline across both round trips, not one each.** `pinLeagueRules` makes
 * two — the upload, then the read-back that proves the bytes survived — and this
 * sits inside a user-facing POST that has already committed a league. A fresh
 * timeout per request would make the real bound twice this number, which is what
 * this comment claimed before review caught it: a per-call timer described as a
 * whole-publish one. `publishLeagueRules` now creates a single signal and hands
 * it to both, so the figure below is the figure.
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
   * Not published. The league exists and is usable, and its rules are unaffected.
   *
   * **Nothing retries.** `leagues_unpinned_idx` in `0044` exists so these can be
   * found, and no job reads it — so a league that fails here stays unpublished
   * until somebody goes looking. That is the honest state of it; do not write a
   * comment implying a sweep until one exists.
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
 *
 * @param signal Abort applied to every request this service makes. **Required**,
 * and passed in rather than created here, so one deadline can span a whole
 * publish — a service that made its own would give each round trip a fresh one,
 * which is exactly the defect review found in the first version of this file.
 * Optional would have made the unbounded service the default one.
 */
export function pinningService(signal: AbortSignal): PinningService | null {
  const jwt = process.env.PINATA_JWT;
  if (!jwt) return null;

  const gateway = process.env.PINATA_GATEWAY;
  return new PinataPinningService({
    jwt,
    // Only pass it when set, so the service keeps its own default rather than
    // receiving an empty string. `exactOptionalPropertyTypes` is on.
    ...(gateway ? { gateway } : {}),
    // The caller's signal, verbatim. Not `AbortSignal.timeout(...)` built here —
    // that is a fresh clock per request, and two requests would then take twice
    // the bound this file advertises.
    fetchImpl: (input, init) => fetch(input, { ...init, signal }),
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
 * @param service Omit to use the configured one. `null` means deliberately
 * unconfigured, which is why this is not simply a default argument: the two are
 * different answers and a default would collapse them.
 */
export async function publishLeagueRules(
  db: SqlClient,
  leagueId: string,
  rules: LeagueRules,
  service?: PinningService | null,
): Promise<PublishOutcome> {
  /*
    One deadline for the whole publish, created here and shared by both round
    trips. Built before the service so it can be handed to it — a service that
    made its own would restart the clock on the read-back, which is exactly the
    defect review found in the first version of this file.
  */
  const resolved =
    service === undefined ? pinningService(AbortSignal.timeout(PUBLISH_TIMEOUT_MS)) : service;

  if (!resolved) {
    return { published: false, reason: "No pinning service is configured (PINATA_JWT)" };
  }

  try {
    const pinned = await pinLeagueRules(resolved, rules, `rules-${leagueId}.json`);

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
    // Deliberately broad. Every failure here leaves the same state — the league
    // stands, unpublished — so distinguishing a timeout from a refused upload
    // from a failed read-back would change nothing the caller does. The message
    // keeps the distinction for whoever reads the log, which is currently the
    // only way any of these is ever noticed.
    return { published: false, reason: describeFailure(error) };
  }
}

/**
 * A reason string for anything that can be thrown.
 *
 * `String(error)` is not total: an object with a null prototype has no
 * `toString`, so stringifying one throws `Cannot convert object to primitive
 * value` — out of the catch block, from the function whose contract is that it
 * never throws. Unreachable through `PinataPinningService`, which throws only
 * `PinningError` or lets a `fetch` error through, so this guards a hostile or
 * future implementation rather than a live path.
 */
function describeFailure(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  try {
    return String(error);
  } catch {
    return "A pinning service threw something that cannot be described";
  }
}
