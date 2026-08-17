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
  /** Unix seconds. Drives lineup locks and every scheduled job. `0` when the
   * provider has not fixed a kickoff time — see `kickoffTbd`. */
  readonly kickoffAt: number;
  /**
   * The provider has this fixture's date but not its kickoff time.
   *
   * The NFL holds back the times of its late-December games for flex
   * scheduling, and Tank01 sends those with `gameTime: "TBD"` and an empty
   * `gameTime_epoch` while still giving the date and both teams. Before this
   * flag existed the whole row was discarded, which is how weeks 16 and 17 came
   * to be four fixtures short each.
   *
   * A consumer must not treat `kickoffAt` as fact while this is true.
   */
  readonly kickoffTbd: boolean;
  /**
   * The provider's own calendar date for the fixture, `YYYYMMDD`, or null.
   *
   * Carried so a conservative kickoff can be derived from the game's dated
   * siblings rather than computed from a timezone by hand.
   */
  readonly gameDate: string | null;
  readonly status: "SCHEDULED" | "IN_PROGRESS" | "FINAL" | "POSTPONED" | "CANCELLED";
}

export interface ProviderBoxScore {
  readonly gameRef: string;
  /**
   * The season and week this box score belongs to.
   *
   * **A provider that is handed only a game reference cannot know these**, and
   * `Tank01Provider.getBoxScore` returns `0` for both. A caller must take them
   * from its own `games` row: writing these straight into `stat_lines` lands
   * every row at season 0, week 0, where nothing ever reads it and every
   * matchup scores zero with no error anywhere.
   */
  readonly season: number;
  readonly week: number;
  /** Keyed by player external ref. */
  readonly players: ReadonlyMap<string, readonly StatLine[]>;
  /**
   * Things that did not reconcile, carried rather than thrown.
   *
   * A discrepancy in one player's line is not a reason to discard the other
   * ninety — see `getBoxScore`. The caller is expected to record these against
   * the game so a stat that quietly went missing is visible afterwards.
   */
  readonly warnings: readonly string[];
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
