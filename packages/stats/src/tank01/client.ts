/**
 * Tank01, via RapidAPI.
 *
 * The primary feed: box scores, players, schedules, injuries, news. $10/month on
 * the Pro tier, free on Basic for development.
 *
 * Only the transport and the shape translation live here. Nothing in this file
 * knows what a fantasy point is.
 */

import { ProviderError } from "../provider.js";
import type { ProviderHealth } from "../provider.js";

const HOST = "tank01-nfl-live-in-game-real-time-statistics-nfl.p.rapidapi.com";

export interface Tank01Options {
  readonly apiKey: string;
  /** Injectable for tests. Defaults to global `fetch`. */
  readonly fetchImpl?: typeof globalThis.fetch;
  /**
   * Attempts per request, including the first. Defaults to
   * {@link REQUEST_ATTEMPTS}.
   *
   * Injectable so a test can pin how many round trips it expects rather than
   * inferring them from a constant it does not control — the same reasoning
   * `randomness.ts` gives for the beacon's.
   */
  readonly attempts?: number;
  /** Injectable so retry backoff costs a test no wall-clock time. */
  readonly sleepImpl?: (ms: number) => Promise<void>;
}

/**
 * Three, matching `RPC_ATTEMPTS` in `packages/db/src/randomness.ts`.
 *
 * Not tuned independently: the two clients have the same shape of exposure —
 * sequential unpaced calls at a metered endpoint — and a second number would be
 * a second thing to reason about with no evidence behind it.
 */
const REQUEST_ATTEMPTS = 3;

/** First backoff step; doubles per attempt. 200ms, 400ms. */
const RETRY_BASE_MS = 200;

/**
 * Whether a failure is worth asking again.
 *
 * **Narrow on purpose.** A rejected key, a 404 and a malformed envelope answer
 * identically however many times they are asked, so retrying them turns a clear
 * failure into a slow one. Giving up early is also cheap here in a way it is not
 * for the draw: `syncBoxScores` records the error against that game and the next
 * tick picks it up ten minutes later.
 *
 * A transport error counts — a socket reset mid-Sunday is exactly the transient
 * this exists for — but an unrecognised HTTP status does not, for the same
 * fail-closed reason `blockTime` refuses to read an unknown RPC error as a
 * skipped slot.
 */
function isRetryable(error: unknown): boolean {
  if (!(error instanceof ProviderError)) return false;

  // A thrown fetch: DNS, connection reset, timeout. The message is composed in
  // one place below, so matching it is a check on this file rather than on the
  // runtime's wording.
  if (error.message.includes("failed")) return true;

  // Rate limited, or the far side is unwell. Both pass with a wait.
  if (error.message.includes("HTTP 429")) return true;
  return /HTTP 5[0-9][0-9]/.test(error.message);
}

interface Tank01Envelope<T> {
  statusCode?: number;
  body?: T;
  error?: string;
}

export class Tank01Client {
  readonly name = "tank01";
  private readonly apiKey: string;
  private readonly doFetch: typeof globalThis.fetch;
  private readonly attempts: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: Tank01Options) {
    if (!options.apiKey) {
      throw new ProviderError(
        "TANK01_API_KEY is not set. See docs/SETUP-REQUIRED.md.",
        "tank01",
      );
    }
    this.apiKey = options.apiKey;
    this.doFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.attempts = options.attempts ?? REQUEST_ATTEMPTS;
    this.sleep = options.sleepImpl ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
  }

  /**
   * Raw GET against a Tank01 endpoint, unwrapping its `{ body }` envelope.
   *
   * **Retried, since #97.** Three attempts with a doubling backoff — the same
   * shape `randomness.ts` gives the Solana beacon, and for the same reason
   * `CLAUDE.md` records there: sequential unpaced calls at a metered endpoint
   * meet a rate limit eventually, and one that fails the caller costs more than
   * the wait.
   *
   * The exposure is newer here than the code is. Every sync before the box-score
   * producer was operator-run and infrequent; `syncBoxScores` is the first
   * caller to make **bursts of sequential calls on a schedule**, one per game, at
   * the top of a ten-minute tick.
   *
   * And a dropped game is no longer merely missing. Since #140 a FINAL game with
   * no box score **holds the whole week from finalising** until the correction
   * window runs out — so a single unretried 429 on a Sunday now costs either a
   * week that will not settle or, past the window, one that settles with those
   * players at zero permanently.
   */
  async get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      try {
        return await this.attempt<T>(path, params);
      } catch (error) {
        lastError = error;

        /*
          Retried only when trying again could plausibly work.

          A bad key, a malformed envelope or a 404 will answer identically
          however many times it is asked, and retrying them turns a clear failure
          into a slow one. `isRetryable` is deliberately narrow for the same
          reason `blockTime` is narrow about what counts as a skipped slot: the
          fail-closed direction here is to give up and report, because the caller
          records the error per game and the next tick tries again anyway.
        */
        if (attempt === this.attempts || !isRetryable(error)) throw error;

        await this.sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
      }
    }

    // Unreachable: the loop either returns or throws. Present so the function is
    // total rather than relying on the reader to prove that.
    throw lastError;
  }

  private async attempt<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(`https://${HOST}/${path}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    let response: Response;
    try {
      response = await this.doFetch(url.toString(), {
        headers: {
          "X-RapidAPI-Key": this.apiKey,
          "X-RapidAPI-Host": HOST,
        },
      });
    } catch (error) {
      throw new ProviderError(`Request to ${path} failed`, "tank01", error);
    }

    if (response.status === 401 || response.status === 403) {
      throw new ProviderError(
        `Tank01 rejected the API key (HTTP ${response.status}). ` +
          `Check TANK01_API_KEY, and that you are subscribed to the NFL API ` +
          `specifically — each Tank01 sport needs its own subscription.`,
        "tank01",
      );
    }
    if (response.status === 429) {
      /**
       * Report what the response says, never what the plan was assumed to be.
       *
       * This used to read "The Basic tier allows 1,000 calls/month" on every
       * 429, which is wrong twice. RapidAPI returns 429 for a **burst** limit as
       * well as an exhausted quota, and the two need opposite responses — wait a
       * second, or wait for the reset. And the tier is not this code's to know:
       * the message sent somebody to check a monthly quota on an account that
       * had been upgraded, when the request was simply too quick after the last.
       *
       * The headers carry the truth and cost nothing to read. `reset` is
       * seconds until the window rolls, which is also what distinguishes a
       * daily allowance from a monthly one without anybody guessing.
       */
      const limit = response.headers.get("x-ratelimit-requests-limit");
      const remaining = response.headers.get("x-ratelimit-requests-remaining");
      const reset = response.headers.get("x-ratelimit-requests-reset");

      const detail =
        remaining === null && limit === null
          ? "No rate-limit headers came back, so this may be a per-second burst limit rather than an exhausted quota."
          : `${remaining ?? "?"} of ${limit ?? "?"} requests left${
              reset === null ? "" : `, window resets in ${reset}s`
            }.`;

      throw new ProviderError(`Tank01 refused the request (HTTP 429). ${detail}`, "tank01");
    }
    if (!response.ok) {
      throw new ProviderError(`Tank01 returned HTTP ${response.status}`, "tank01");
    }

    const envelope = (await response.json()) as Tank01Envelope<T>;
    if (envelope.error) {
      throw new ProviderError(`Tank01 error: ${envelope.error}`, "tank01");
    }
    if (envelope.body === undefined) {
      throw new ProviderError(`Tank01 returned no body for ${path}`, "tank01");
    }

    return envelope.body;
  }

  /**
   * Cheap call that proves the key works.
   *
   * Uses the team list: small, always available, and independent of the season
   * being underway.
   */
  async healthCheck(): Promise<ProviderHealth> {
    try {
      const teams = await this.get<unknown[]>("getNFLTeams");
      const count = Array.isArray(teams) ? teams.length : 0;

      return {
        ok: count > 0,
        provider: this.name,
        detail:
          count > 0
            ? `Connected. ${count} NFL teams returned.`
            : "Connected, but the team list came back empty.",
      };
    } catch (error) {
      return {
        ok: false,
        provider: this.name,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
