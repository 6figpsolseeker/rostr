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

/**
 * Who a player is, as opposed to what he did.
 *
 * Split from `ProviderPlayer` rather than flattened into it because the two
 * carry different obligations. The fields there identify a player and are read
 * by the draft, the roster and every score; **nothing in this type is read by
 * anything that decides an outcome**, and a provider that publishes none of it
 * costs a screen some detail and costs a league nothing.
 *
 * So a null here is ordinary rather than an error, and no caller may come to
 * depend on one being present.
 */
export interface ProviderPlayerProfile {
  /**
   * A headshot, or a crest for a team unit. Absolute, and the provider's own.
   *
   * Published rather than composed from an id. The provider's URLs are not
   * uniform — rookies and players with no photo sit on different paths, 361 of
   * 4,202 on 2026-08-18 — and composing one here would hard-code another
   * company's hostname into ours, which is the coupling this interface exists
   * to prevent.
   */
  readonly imageUrl: string | null;
  /** Text, not a number: `"00"` is a jersey somebody wears. */
  readonly jerseyNumber: string | null;
  /** Whole inches and whole pounds. Integers — see invariant 2. */
  readonly heightInches: number | null;
  readonly weightPounds: number | null;
  /** ISO `YYYY-MM-DD`. The date, never a computed age. */
  readonly birthDate: string | null;
  readonly college: string | null;
  /** Where they entered the league. Null for an undrafted player. */
  readonly draft: {
    readonly year: number;
    readonly round: number;
    readonly pick: number;
  } | null;
  /**
   * The provider's own wording — "Questionable", "Out", "Injured Reserve".
   *
   * Not normalised onto an enum of ours, because an unfamiliar fourth value has
   * to reach the screen rather than be dropped or fail a cast. **Nothing may
   * gate a lineup on it**: `RULES.md` §6 locks a slot on that player's own
   * kickoff, not on whether he is fit, and starting a doubtful player is a
   * manager's call to make.
   */
  readonly injury: {
    readonly designation: string;
    readonly description: string | null;
    /** ISO `YYYY-MM-DD`, when the provider offers one. */
    readonly returnDate: string | null;
  } | null;
}

export interface ProviderPlayer {
  /** The provider's own identifier, stored so players survive a provider switch. */
  readonly externalRef: string;
  readonly fullName: string;
  /** Registry position keys — "QB", "WR", "DEF". */
  readonly positions: readonly string[];
  readonly teamRef: string | null;
  readonly active: boolean;
  /** Display detail. Null where the provider publishes none. */
  readonly profile: ProviderPlayerProfile | null;
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
