/**
 * Sleeper, live.
 *
 * The second of the two independent providers `RULES.md` §7 requires to agree
 * before a week's scores finalise. Until now Sleeper existed here only as
 * checked-in fixtures the conformance corpus compares against — which proved
 * the *translation* was right and did nothing at ingest time, where it matters.
 *
 * ## Why Sleeper and not a third read of ESPN
 *
 * Tank01 **is** ESPN reserialised — measured, not assumed: byte-identical
 * scoring text down to a `"Touchown"` typo, and Tank01's `playerID` is the ESPN
 * athlete id. So an ESPN column corroborates nothing; where ESPN is wrong,
 * Tank01 is wrong identically and both read green. Sleeper is the only genuinely
 * independent opinion this project has, and it is the one that found the
 * defects in #157.
 *
 * ## What makes this cheap
 *
 * No API key, no account, no quota to manage — the stats endpoint is public. And
 * **one call covers an entire week for every player**, so a second source costs
 * one request per week rather than one per game. That is the whole reason this
 * is affordable alongside a metered provider.
 */

import { ProviderError } from "../provider.js";
import type { SleeperStats } from "./stats.js";

const BASE = "https://api.sleeper.app/v1";

/** How long to wait before giving up on a request. */
const TIMEOUT_MS = 15_000;

/**
 * A whole week of stats, keyed by Sleeper's own player id.
 *
 * Team defences appear under their abbreviation (`"PHI"`) rather than a numeric
 * id, which is why `players.second_source_ref` holds the team ref for a D/ST.
 */
export type SleeperWeek = Readonly<Record<string, SleeperStats>>;

export interface SleeperClientOptions {
  /** Injected in tests. Defaults to the global. */
  readonly fetch?: typeof globalThis.fetch;
  readonly baseUrl?: string;
}

export class SleeperClient {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly baseUrl: string;

  constructor(options: SleeperClientOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.baseUrl = options.baseUrl ?? BASE;
  }

  /**
   * Every player's stats for one week.
   *
   * `seasonType` is `"regular"` — the only one this project scores. Sleeper also
   * serves `"post"`, and asking for the wrong one returns a valid empty-ish body
   * rather than an error, which is exactly the shape of failure that reads as
   * "the second source agrees with everything".
   *
   * **An empty body is refused rather than returned.** A week Sleeper has not
   * published yet answers `{}`, and treating that as data would let a comparison
   * conclude the two sources agree because one of them said nothing. The caller
   * needs to tell "no disagreement" from "no opinion", and only a throw does
   * that unambiguously.
   */
  async weekStats(season: number, week: number): Promise<SleeperWeek> {
    const url = `${this.baseUrl}/stats/nfl/regular/${season}/${week}`;
    const body = await this.get(url);

    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new ProviderError(
        `Sleeper returned ${Array.isArray(body) ? "an array" : typeof body} for ` +
          `${season} week ${week}, not a map of player stats`,
        "sleeper",
      );
    }

    const entries = Object.entries(body as Record<string, unknown>);
    if (entries.length === 0) {
      throw new ProviderError(
        `Sleeper has no stats for ${season} week ${week} yet. This is not agreement — ` +
          `a comparison against an empty week would report every player as matching.`,
        "sleeper",
      );
    }

    const out: Record<string, SleeperStats> = {};
    for (const [playerId, stats] of entries) {
      // A non-object entry is skipped rather than throwing the week away. One
      // malformed row should not cost the comparison every other player in it.
      if (typeof stats !== "object" || stats === null || Array.isArray(stats)) continue;

      const numeric: Record<string, number> = {};
      for (const [field, value] of Object.entries(stats as Record<string, unknown>)) {
        // Sleeper serves numbers, but a numeric string is accepted rather than
        // dropped — dropping removes a value from one side of a comparison,
        // which reads as a disagreement we invented rather than one the data
        // contains.
        //
        // **Narrowed to those two types deliberately.** `Number(null)` is 0 and
        // `Number("")` is 0, so a permissive `Number(value)` turns "no value"
        // into a real zero — and absent is not zero is the rule the scoring
        // engine already enforces, because a defence that allowed 0 points earns
        // a shutout bonus a missing one must not. Caught by its own test.
        if (typeof value === "number") {
          if (Number.isFinite(value)) numeric[field] = value;
          continue;
        }
        if (typeof value !== "string" || value.trim() === "") continue;
        const parsed = Number(value);
        if (Number.isFinite(parsed)) numeric[field] = parsed;
      }
      out[playerId] = numeric;
    }

    return out;
  }

  private async get(url: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await this.fetchImpl(url, {
        signal: controller.signal,
        headers: { accept: "application/json" },
      });

      if (!response.ok) {
        throw new ProviderError(
          `Sleeper returned HTTP ${response.status} for ${url}`,
          "sleeper",
        );
      }

      return await response.json();
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      // An abort is a timeout here, and saying so is more useful than
      // "The operation was aborted" reaching a cron heartbeat.
      const reason =
        error instanceof Error && error.name === "AbortError"
          ? `no response within ${TIMEOUT_MS}ms`
          : error instanceof Error
            ? error.message
            : String(error);
      throw new ProviderError(`Sleeper request failed: ${reason}`, "sleeper");
    } finally {
      clearTimeout(timer);
    }
  }
}
