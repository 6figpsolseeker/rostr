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
 * How long one request may hang before it is abandoned.
 *
 * The same 15s the Sleeper client uses. There was none here at all, which made
 * the retry unreachable for the failure it most needed to cover: a hung socket
 * at a throttling gateway never throws, so nothing was ever retried and the
 * tick simply stalled.
 */
const REQUEST_TIMEOUT_MS = 15_000;

/*
 * A 429 whose window rolls no sooner than this is treated as spent, not busy.
 *
 * Ten minutes is the stats cron's own period: past it, the next tick will ask
 * again anyway, so sleeping 600ms and spending two more calls buys nothing.
 */
const QUOTA_RESET_FLOOR_S = 600;

/*
 * A request failure, carrying whether asking again could plausibly work.
 *
 * **The decision is made where the evidence is, and this used to be a substring
 * match on the message.** That was wrong twice. Its comment claimed "the message
 * is composed in one place below, so matching it is a check on this file" — but
 * a provider error body is interpolated into a `ProviderError` too, so any
 * Tank01 error string containing the word "failed" was retried three times. And
 * a 429 arrives with headers saying whether the window rolls in a second or in
 * fifteen hours, which the throw site read, formatted into prose, and discarded.
 *
 * Narrow on purpose, still: a rejected key, a 404 and a malformed envelope
 * answer identically however many times they are asked, and an unrecognised
 * status fails closed — the same direction `blockTime` takes about an
 * unrecognised RPC error. Giving up early is cheap here in a way it is not for
 * the draw, because `syncBoxScores` records the error against that game and a
 * later tick re-reads it. **Not the next one** — this said "ten minutes later",
 * and `FAILED_RETRY_MINUTES` is 20 against a ten-minute cron, so it is the tick
 * after next. That interval is the whole argument for giving up early, which
 * makes it worth stating correctly.
 */
class Tank01RequestError extends ProviderError {
  constructor(
    message: string,
    readonly retryable: boolean,
    cause?: unknown,
  ) {
    super(message, "tank01", cause);
    this.name = "Tank01RequestError";
  }
}

function isRetryable(error: unknown): boolean {
  return error instanceof Tank01RequestError && error.retryable;
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
    // Guarded rather than defaulted, which is what `randomness.ts` does and
    // says why. `options.attempts ?? REQUEST_ATTEMPTS` lets 0 and NaN through
    // because neither is nullish, and the loop below then runs zero times and
    // falls to `throw lastError` with `lastError` still undefined — `throw
    // undefined`, no HTTP call, recorded downstream as the literal "undefined".
    this.attempts = Number.isFinite(options.attempts)
      ? Math.max(1, Math.floor(options.attempts as number))
      : REQUEST_ATTEMPTS;
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
   * The exposure is newer here than the code is, though this used to overstate
   * how. It called `syncBoxScores` the **first** caller to burst on a schedule;
   * `season-sync` makes eighteen sequential `listGames` calls plus four more,
   * and the two crons landed in the same commit. What is particular to the
   * box-score producer is the cadence — twenty calls at the top of a ten-minute
   * tick, all day on a Sunday — and that a dropped one decides a matchup.
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

    /*
      A deadline, because there was none and the sibling Sleeper client has one.

      Without it a stalled connection is bounded only by the runtime's defaults,
      and since #97 there are three of them per game — inside a serverless
      function whose own limit nothing here sets.
    */
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      let response: Response;
      try {
        response = await this.doFetch(url.toString(), {
          signal: controller.signal,
          headers: {
            "X-RapidAPI-Key": this.apiKey,
            "X-RapidAPI-Host": HOST,
          },
        });
      } catch (error) {
        throw new Tank01RequestError(`Request to ${path} failed`, true, error);
      }

      if (response.status === 401 || response.status === 403) {
        throw new Tank01RequestError(
          `Tank01 rejected the API key (HTTP ${response.status}). ` +
            `Check TANK01_API_KEY, and that you are subscribed to the NFL API ` +
            `specifically — each Tank01 sport needs its own subscription.`,
          false,
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

        /*
          Busy or spent, and they are not the same request to make again.

          The headers above already tell them apart — that is what the comment
          there is about — and the retry then ignored the answer and asked twice
          more at 200ms and 400ms. Against a window measured in hours those two
          calls are guaranteed futile, and they are spent on the quota that
          refused the first one. Past the floor the next tick will ask anyway.
        */
        const resetIn = reset === null ? null : Number.parseInt(reset, 10);
        const spent =
          remaining === "0" && resetIn !== null && Number.isFinite(resetIn)
            ? resetIn >= QUOTA_RESET_FLOOR_S
            : false;

        throw new Tank01RequestError(
          `Tank01 refused the request (HTTP 429). ${detail}`,
          !spent,
        );
      }
      if (!response.ok) {
        // 5xx is the far side being unwell and passes with a wait. Every other
        // status answers the same however often it is asked, and an unrecognised
        // one fails closed.
        throw new Tank01RequestError(
          `Tank01 returned HTTP ${response.status}`,
          response.status >= 500 && response.status <= 599,
        );
      }

      /*
        Inside the guard, because a reset **during the body** is the transient this
        whole change is about and it was the one shape not covered.

        `fetch` resolves at the headers and streams the rest, so a connection lost
        partway through rejects here rather than at the call above — and a box
        score is the largest response this client asks for, tens of kilobytes over
        many packets, which is exactly where that happens. It arrived as a bare
        `TypeError`, failed the `instanceof` check, and was never retried. A
        truncated body or an HTML error page under a 200 lands here too.
      */
      let envelope: Tank01Envelope<T>;
      try {
        envelope = (await response.json()) as Tank01Envelope<T>;
      } catch (error) {
        throw new Tank01RequestError(`Reading ${path} failed`, true, error);
      }
      if (envelope.error) {
        /*
          Provider text, so nothing here may be pattern-matched — that was the
          hole in the old predicate. The **declared status** is what decides.

          `statusCode` has been on this envelope since it was written and was
          read nowhere, which is a divergence this repo has already paid for
          once: `randomness.ts` carries 429 in its transient list precisely
          because "some providers deliver a rate limit as HTTP 200 with the
          limit in the error body, where the HTTP-status retry never sees it",
          and CLAUDE.md records that the retry there "never fired for the case
          it was added for".

          Whether Tank01 does this is **unverified** — no 429 of any shape has
          ever been captured from it, which `docs/TANK01.md` now says out loud.
          Handling it costs nothing; not handling it costs the one case the
          retry exists for. Same trade, same reasoning.
        */
        const declared = envelope.statusCode;
        throw new Tank01RequestError(
          `Tank01 error: ${envelope.error}`,
          declared === 429 || (declared !== undefined && declared >= 500 && declared <= 599),
        );
      }
      if (envelope.body === undefined) {
        throw new Tank01RequestError(`Tank01 returned no body for ${path}`, false);
      }

      return envelope.body;
    } finally {
      // Cleared on every path. An uncleared deadline keeps the runtime's event
      // loop alive for its full duration after the request has finished, which
      // is 15 seconds per call in a job that makes twenty of them.
      clearTimeout(deadline);
    }
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
