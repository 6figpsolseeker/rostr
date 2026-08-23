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

  constructor(options: Tank01Options) {
    if (!options.apiKey) {
      throw new ProviderError(
        "TANK01_API_KEY is not set. See docs/SETUP-REQUIRED.md.",
        "tank01",
      );
    }
    this.apiKey = options.apiKey;
    this.doFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  /** Raw GET against a Tank01 endpoint, unwrapping its `{ body }` envelope. */
  async get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
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
