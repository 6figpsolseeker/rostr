/**
 * The stats provider interface.
 *
 * Every provider in this space gets re-evaluated once there is revenue, and
 * settlement requires two of them agreeing. So nothing downstream — not the
 * scoring engine, not the draft, not the job runner — may ever learn which
 * provider is behind this.
 *
 * The interface speaks in the sport registry's own vocabulary: stat *keys*, not
 * a provider's field names. Translating a provider's shape into ours is the
 * adapter's entire job, and it is where the mess belongs.
 */

import type { StatLine } from "@rostr/core";

export interface ProviderPlayer {
  /** The provider's own identifier, stored so players survive a provider switch. */
  readonly externalRef: string;
  readonly fullName: string;
  /** Registry position keys — "QB", "WR", "DEF". */
  readonly positions: readonly string[];
  readonly teamRef: string | null;
  readonly active: boolean;
}

export interface ProviderGame {
  readonly externalRef: string;
  readonly season: number;
  readonly week: number;
  readonly homeTeamRef: string;
  readonly awayTeamRef: string;
  /** Unix seconds. Drives lineup locks and every scheduled job. */
  readonly kickoffAt: number;
  readonly status: "SCHEDULED" | "IN_PROGRESS" | "FINAL" | "POSTPONED" | "CANCELLED";
}

export interface ProviderBoxScore {
  readonly gameRef: string;
  readonly season: number;
  readonly week: number;
  /** Keyed by player external ref. */
  readonly players: ReadonlyMap<string, readonly StatLine[]>;
}

export interface ProviderInjury {
  readonly externalRef: string;
  /** Provider wording preserved — "Questionable", "Out", "IR". */
  readonly designation: string;
  readonly description: string | null;
}

export interface StatsProvider {
  /** Stable name, recorded on every `stat_line` so sources stay distinguishable. */
  readonly name: string;

  listPlayers(season: number): Promise<readonly ProviderPlayer[]>;
  listGames(season: number, week?: number): Promise<readonly ProviderGame[]>;
  getBoxScore(gameRef: string): Promise<ProviderBoxScore>;
  listInjuries(): Promise<readonly ProviderInjury[]>;

  /** Cheap call that proves credentials work. Used by `pnpm stats:check`. */
  healthCheck(): Promise<ProviderHealth>;
}

export interface ProviderHealth {
  readonly ok: boolean;
  readonly provider: string;
  readonly detail: string;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ProviderError";
  }
}
