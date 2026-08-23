/**
 * Tank01 as a `StatsProvider`.
 *
 * Everything above this line speaks registry vocabulary; everything below it
 * speaks Tank01. This is the seam.
 */

import { ProviderError } from "../provider.js";
import type {
  ProviderBoxScore,
  ProviderGame,
  ProviderHealth,
  ProviderInjury,
  ProviderPlayer,
  ProviderPlayerProfile,
  StatsProvider,
} from "../provider.js";
import { Tank01Client } from "./client.js";
import type { Tank01Options } from "./client.js";
import { translateBoxScore } from "./box-score.js";
import { parseStatValue } from "./stat-map.js";
import { isSeasonAggregate, parseSeasonProjections } from "./projections.js";
import type { ProviderProjection, RawProjectionsBody } from "./projections.js";

/**
 * Tank01 position codes to registry positions.
 *
 * **A map, not a filter.** An earlier version filtered on a set that included
 * `"K"`, which silently dropped every kicker: Tank01 says **`PK`**. The sync
 * reported 33 unmatched rankings and nothing else looked wrong, so a draft board
 * with no kickers would have shipped — and since every league starts one, no
 * team could have fielded a legal lineup.
 *
 * Verified against `getNFLPlayerList`, which uses:
 *
 *     WR 645   LB 615   CB 529   DT 403   S 346   RB 315   TE 311
 *     DE 269   OT 212   QB 175   G 162    C 98    PK 69    P 59
 *     LS 51    FB 27    OL 5     DB 2     KR 1    DL 1
 *
 * Everything not listed below is defensive, offensive line, or special teams
 * personnel we never roster — around 3,000 players nobody could draft.
 */
const POSITION_MAP: Readonly<Record<string, string>> = {
  QB: "QB",
  RB: "RB",
  // Fullbacks are running backs in fantasy. ESPN and Sleeper both list them
  // that way, and Tank01's own ADP ranks Kyle Juszczyk as "RB90".
  FB: "RB",
  WR: "WR",
  TE: "TE",
  // Not "K". This is the one that bit.
  PK: "K",
};

/**
 * Team defenses are not players.
 *
 * They are rosterable in fantasy but Tank01 has no player record for them, so
 * one is synthesised per team. The `DST_` prefix keeps the external ref from
 * ever colliding with a real Tank01 player ID.
 */
export const DST_REF_PREFIX = "DST_";

/**
 * Where Sleeper's team abbreviations differ from ours.
 *
 * A table rather than a fuzzy match, for the reason the corpus records: a
 * D/ST joined to the wrong team is a swing between two rosters. Only
 * Washington differs — `LAR`, `LV` and `JAX`, the ones that usually vary
 * between feeds, are identical here.
 */
const SLEEPER_TEAM_ALIASES: Readonly<Record<string, string>> = { WSH: "WAS" };

export interface AdpEntry {
  readonly externalRef: string;
  readonly fullName: string;
  /** Average draft position in milli-units: "3.2" -> 3200. */
  readonly overallMilli: number;
  readonly positionRank: string | null;
}

export interface AdpBoard {
  /** The date the provider stamped, as YYYY-MM-DD. */
  readonly asOf: string;
  readonly rankingType: string;
  readonly entries: readonly AdpEntry[];
}

interface RawDraftInfo {
  round?: string;
  pick?: string;
  year?: string;
}

interface RawPlayer {
  playerID?: string;
  /** Sleeper's own id for this player, published by Tank01. The two-source join key. */
  sleeperBotID?: string;
  longName?: string;
  pos?: string;
  team?: string;
  isFreeAgent?: string;
  injury?: { designation?: string; description?: string; injReturnDate?: string };
  espnHeadshot?: string;
  jerseyNum?: string;
  height?: string;
  weight?: string;
  bDay?: string;
  school?: string;
  draftInfo?: RawDraftInfo;
}

interface RawTeam {
  teamAbv?: string;
  teamCity?: string;
  teamName?: string;
  byeWeeks?: Record<string, string[]>;
  espnLogo1?: string;
}

interface RawGame {
  gameID?: string;
  gameWeek?: string;
  home?: string;
  away?: string;
  gameTime_epoch?: string;
  gameStatus?: string;
  /** `YYYYMMDD`. Present even when the kickoff time is not — verified live on
   * 2026-08-17, see `listGames`. */
  gameDate?: string;
  /** `"TBD"` for a fixture the NFL has not given a time. Observed, not guessed. */
  gameTime?: string;
}

/**
 * Tank01's game status wording to ours.
 *
 * **`"Completed"` is the one form we have actually observed**, and it was
 * missing. `__fixtures__/box-score.json` is the only real Tank01 response in the
 * repo and it carries `gameStatus: "Completed"` with `gameStatusCode: "2"`; every
 * other branch below was written from documentation. The unit test that appears
 * to cover this feeds `"Final"` — a string invented in the test, not captured —
 * so it passed while the mapping was wrong for the only evidence available.
 *
 * That miss is not cosmetic. An unrecognised status falls to `SCHEDULED`, so
 * `syncGames` writes every finished game as unstarted with a null `final_at`,
 * `finalizationHold` counts `finished = 0`, and every week in the season
 * finalises down `RULES.md` §10's postponement fallback — the path reserved for
 * a game that was never played. It is the fourth time a field guessed from
 * documentation has been wrong here.
 *
 * So: match on a prefix rather than an exact string, because the observed
 * vocabulary is inconsistent (`"Completed"`, and `docs/TANK01.md` records
 * `"Final/OT"` elsewhere), and treat an unrecognised value as `SCHEDULED` **but
 * say so** — a silent default is what hid this.
 *
 * ## The prefix hedge earned its keep, measured 2026-08-15
 *
 * Probed live, and the endpoints do not agree with each other. A finished game
 * is `"Final"` from `getNFLGamesForWeek` and `"Completed"` from both
 * `getNFLScoresOnly` and `getNFLBoxScore` — and the scores endpoint is the one
 * the game watcher polls, so a mapping written against the schedule endpoint
 * alone would have read every finished game as unstarted. Full table in
 * `docs/TANK01.md`.
 *
 * **`gameStatusCode` is the stable half and this deliberately does not use it.**
 * `"2"` means finished on all three endpoints and `"0"` means not started, which
 * is a better discriminator than any string. Only those two values have been
 * seen: no game is in progress, postponed or cancelled in August, so the rest of
 * the code vocabulary is unknown. Switching to it now would mean guessing the
 * remaining values, which is exactly how four field names in this file were
 * wrong. Switch after a live Sunday, not before.
 *
 * For the same reason `IN_PROGRESS`, `POSTPONED` and `CANCELLED` below are still
 * documentation rather than evidence.
 */
function mapGameStatus(status: string | undefined): ProviderGame["status"] {
  const raw = (status ?? "").trim().toLowerCase();

  if (raw.startsWith("final") || raw.startsWith("completed")) return "FINAL";
  if (raw.startsWith("in progress") || raw.startsWith("live")) return "IN_PROGRESS";
  if (raw.startsWith("halftime")) return "IN_PROGRESS";
  if (raw.startsWith("postponed")) return "POSTPONED";
  if (raw.startsWith("cancel") || raw.startsWith("canceled")) return "CANCELLED";
  if (raw === "" || raw.startsWith("scheduled") || raw.startsWith("not started")) {
    return "SCHEDULED";
  }

  // Loud, because the silent version of this cost a season's finalisation. It
  // still answers `SCHEDULED` — refusing outright would take a whole sync down
  // over one unfamiliar word — but an operator gets told rather than the wrong
  // answer being written 16 times a week without comment.
  // eslint-disable-next-line no-console
  console.warn(
    `[tank01] unrecognised gameStatus ${JSON.stringify(status)} — treating it as ` +
      `SCHEDULED. If this is a finished game, finalisation will fall back to the ` +
      `postponement path. Record the verbatim string in docs/TANK01.md and add it here.`,
  );
  return "SCHEDULED";
}

/**
 * Tank01's fields for the profile block, verified against the live player list
 * on 2026-08-18 (4,202 entries) rather than read off documentation. Field names
 * guessed from docs have been wrong three times on this project.
 *
 * Shapes seen, and every one of them is handled below:
 *   height    `"6'2\""`, or `""`
 *   weight    `"230"`,   or `""`
 *   bDay      `"7/29/1993"` — American order, always, 4,145 of 4,202
 *   draftInfo `{ round, pick, year, teamID }` or absent (2,133 have it)
 *   injury    always present; `designation` empty for 4,017 of them
 *   injReturnDate `"20270215"`, or `""`
 */
const NO_PHOTO = "nophoto";

/** `"6'2\""` to 74. Null for anything that is not that shape. */
function heightInches(raw: string | undefined): number | null {
  const match = /^(\d+)'(\d+)"?$/.exec((raw ?? "").trim());
  if (!match) return null;
  const feet = Number(match[1]);
  const inches = Number(match[2]);
  return feet * 12 + inches;
}

/** Digits only. Rejects `""` and anything with a unit or a range in it. */
function wholeNumber(raw: string | undefined): number | null {
  const text = (raw ?? "").trim();
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * `"7/29/1993"` to `"1993-07-29"`.
 *
 * Month first — the provider is American and every one of the 4,145 published
 * birth dates parses that way. Written out rather than handed to `new Date()`,
 * which would read the same string differently depending on the runtime's
 * locale and silently swap 7 March for 3 July.
 */
function isoFromUsDate(raw: string | undefined): string | null {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec((raw ?? "").trim());
  if (!match) return null;
  const [, month, day, year] = match;
  const asMonth = Number(month);
  const asDay = Number(day);
  if (asMonth < 1 || asMonth > 12 || asDay < 1 || asDay > 31) return null;
  return `${year}-${String(asMonth).padStart(2, "0")}-${String(asDay).padStart(2, "0")}`;
}

/** `"20270215"` to `"2027-02-15"`. */
function isoFromCompactDate(raw: string | undefined): string | null {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec((raw ?? "").trim());
  if (!match) return null;
  const [, year, month, day] = match;
  if (Number(month) < 1 || Number(month) > 12) return null;
  if (Number(day) < 1 || Number(day) > 31) return null;
  return `${year}-${month}-${day}`;
}

/**
 * An image URL, or null where the provider is telling us it has none.
 *
 * The placeholder matters: 36 players resolve to ESPN's own grey silhouette,
 * and storing that would put a foreign "no photo" graphic on our screens in
 * place of the initials fallback we control. A null here is the more useful
 * answer than a URL that loads.
 */
function imageUrl(raw: string | undefined): string | null {
  const url = (raw ?? "").trim();
  if (!url || url.includes(NO_PHOTO)) return null;
  return url;
}

/**
 * Every profile field absent.
 *
 * Spread rather than written out at each use so a field added to the type is a
 * compile error in one place instead of a silently missing key in several.
 */
const EMPTY_PROFILE: ProviderPlayerProfile = {
  imageUrl: null,
  jerseyNumber: null,
  heightInches: null,
  weightPounds: null,
  birthDate: null,
  college: null,
  draft: null,
  injury: null,
};

function profileOf(player: RawPlayer): ProviderPlayerProfile {
  const designation = (player.injury?.designation ?? "").trim();

  return {
    imageUrl: imageUrl(player.espnHeadshot),
    jerseyNumber: (player.jerseyNum ?? "").trim() || null,
    heightInches: heightInches(player.height),
    weightPounds: wholeNumber(player.weight),
    birthDate: isoFromUsDate(player.bDay),
    college: (player.school ?? "").trim() || null,
    draft: draftOf(player.draftInfo),
    injury:
      designation === ""
        ? null
        : {
            designation,
            description: (player.injury?.description ?? "").trim() || null,
            returnDate: isoFromCompactDate(player.injury?.injReturnDate),
          },
  };
}

/**
 * Draft position, or null.
 *
 * All three parts are required together. A round with no pick number is not a
 * partial answer worth rendering — "round 4, pick —" reads as missing data
 * rather than as the fact it is trying to state.
 */
function draftOf(raw: RawDraftInfo | undefined): ProviderPlayerProfile["draft"] {
  if (!raw) return null;
  const year = wholeNumber(raw.year);
  const round = wholeNumber(raw.round);
  const pick = wholeNumber(raw.pick);
  if (year === null || round === null || pick === null) return null;
  return { year, round, pick };
}

export class Tank01Provider implements StatsProvider {
  readonly name = "tank01";
  private readonly client: Tank01Client;

  constructor(options: Tank01Options | Tank01Client) {
    this.client = options instanceof Tank01Client ? options : new Tank01Client(options);
  }

  healthCheck(): Promise<ProviderHealth> {
    return this.client.healthCheck();
  }

  /**
   * Every rosterable player, plus one synthesised entry per team defense.
   */
  async listPlayers(_season: number): Promise<readonly ProviderPlayer[]> {
    const [raw, teams] = await Promise.all([
      this.client.get<RawPlayer[]>("getNFLPlayerList"),
      this.client.get<RawTeam[]>("getNFLTeams"),
    ]);

    const players: ProviderPlayer[] = [];

    for (const player of raw) {
      const position = POSITION_MAP[(player.pos ?? "").toUpperCase()];
      if (!player.playerID || !position) continue;

      players.push({
        externalRef: player.playerID,
        fullName: player.longName ?? "",
        positions: [position],
        teamRef: player.team && player.team !== "FA" ? player.team : null,
        active: player.isFreeAgent !== "True",
        profile: profileOf(player),
        // Published by Tank01 on its own player list, so the two-source join
        // needs no name matching. Empty string is treated as absent: the field
        // is present-but-blank for players Sleeper does not carry, and storing
        // "" would make a player look mapped to nothing rather than unmapped.
        secondSourceRef: player.sleeperBotID ? player.sleeperBotID : null,
      });
    }

    for (const team of teams) {
      if (!team.teamAbv) continue;
      players.push({
        externalRef: `${DST_REF_PREFIX}${team.teamAbv}`,
        fullName: `${team.teamCity ?? ""} ${team.teamName ?? ""}`.trim() || team.teamAbv,
        positions: ["DEF"],
        teamRef: team.teamAbv,
        active: true,
        // A team unit has no face, so its crest stands in — the same slot in the
        // same field, so every screen renders one image and never branches on
        // whether a roster row happens to be eleven people.
        profile: { ...EMPTY_PROFILE, imageUrl: imageUrl(team.espnLogo1) },
        // Sleeper identifies a team unit by its abbreviation rather than by a
        // numeric id, so the join key for a defence is the team ref itself.
        // Sleeper's own abbreviation, not ours. The two agree for 31 teams and
        // disagree for Washington: we carry `WSH` and Sleeper keys the D/ST
        // under `WAS` — verified against the live week endpoint on 2026-08-22,
        // whose 32 team keys include `WAS` and no `WSH`.
        //
        // Without the alias that one unit never joins, and the failure is the
        // quiet kind: the second source simply covers 31 of 32 defences, which
        // is indistinguishable from two feeds that agree.
        secondSourceRef: SLEEPER_TEAM_ALIASES[team.teamAbv] ?? team.teamAbv,
      });
    }

    return players;
  }

  /**
   * A week's fixtures.
   *
   * ## A missing kickoff time is not a missing game
   *
   * Probed live on 2026-08-17, because this had been assumed and never checked.
   * Tank01 returns **all 16** fixtures for every week. The ones the NFL has not
   * yet timed come back fully formed apart from the hour:
   *
   * ```
   * TB @ ATL  gameID=20261227_TB@ATL  gameDate="20261227"
   *           gameTime="TBD"  gameTime_epoch=""  gameStatus="Scheduled"
   * ```
   *
   * This used to collapse that into `kickoffAt: 0` and nothing else, so
   * `syncGames` skipped the row and the date, the opponent and the fixture's
   * existence went with it — which is how weeks 16 and 17 ended up four games
   * short each, in the two weeks that decide a championship.
   *
   * The emptiness is reported rather than resolved here. Choosing a stand-in
   * kickoff needs the game's dated siblings, which is a decision for the caller
   * holding the whole week, not for a translator holding one row.
   */
  async listGames(season: number, week?: number): Promise<readonly ProviderGame[]> {
    const params: Record<string, string> = { season: String(season), seasonType: "reg" };
    if (week !== undefined) params["week"] = String(week);

    const raw = await this.client.get<RawGame[]>("getNFLGamesForWeek", params);

    return raw
      .filter((game): game is RawGame & { gameID: string } => Boolean(game.gameID))
      .map((game) => {
        const kickoff = Number.parseFloat(game.gameTime_epoch ?? "0");
        const kickoffAt = Number.isFinite(kickoff) ? Math.round(kickoff) : 0;

        // Derived from the epoch alone, never from `gameTime === "TBD"`. The
        // epoch is what every downstream consumer actually uses, so keying the
        // flag on it means the flag cannot disagree with the number it
        // describes — and a provider that invents a new wording for "no time
        // yet" still lands here rather than shipping a game stored at 1970.
        const kickoffTbd = kickoffAt <= 0;

        return {
          externalRef: game.gameID,
          season,
          // "Week 1" -> 1
          week: Number.parseInt((game.gameWeek ?? "").replace(/\D+/g, ""), 10) || (week ?? 0),
          homeTeamRef: game.home ?? "",
          awayTeamRef: game.away ?? "",
          kickoffAt,
          kickoffTbd,
          gameDate: game.gameDate && /^\d{8}$/.test(game.gameDate) ? game.gameDate : null,
          status: mapGameStatus(game.gameStatus),
        };
      });
  }

  async getBoxScore(gameRef: string): Promise<ProviderBoxScore> {
    const raw = await this.client.get<unknown>("getNFLBoxScore", { gameID: gameRef });
    const translated = translateBoxScore(raw);

    // **Only `fatal` throws, and that split is the whole point.**
    //
    // This used to throw on any warning at all. One kicker whose `Kicking.fgMade`
    // disagreed with the field goals parsed from his own scoring plays — two
    // independently-updated parts of the same payload — discarded every stat line
    // for all ~90 players in the game.
    //
    // Composed with clock-based finalisation that is not "retry later". The game
    // is still `FINAL`, so `finalizationHold` counts it finished and the
    // postponement fallback never fires; the week settles with sixteen real
    // starters on zero, permanently, with no signal anywhere that anything was
    // missing. A discrepancy about one kicker's 3-versus-4-point bucket is not a
    // reason to throw away ninety players' verified stats.
    //
    // So `fatal` means "we could not read this response" and throws; `warnings`
    // means "we read it and something did not add up" and is carried on the
    // result for the caller to record.
    if (translated.fatal.length > 0) {
      throw new ProviderError(
        `Box score ${gameRef} could not be read:\n  ${translated.fatal.join("\n  ")}`,
        this.name,
      );
    }

    const players = new Map(translated.players);
    // Team defenses are addressed by the same synthetic ref used in listPlayers.
    for (const [teamAbv, lines] of translated.teamDefense) {
      players.set(`${DST_REF_PREFIX}${teamAbv}`, lines);
    }

    return {
      gameRef: translated.gameRef,
      // The caller knows these; this method is handed a gameRef and does not.
      // A producer that trusted them would write every row into a (0, 0)
      // coordinate that nothing ever reads.
      season: 0,
      week: 0,
      players,
      warnings: translated.warnings,
    };
  }

  async listInjuries(): Promise<readonly ProviderInjury[]> {
    const raw = await this.client.get<RawPlayer[]>("getNFLPlayerList");

    return raw
      .filter((player) => player.playerID && player.injury?.designation)
      .map((player) => ({
        externalRef: player.playerID!,
        designation: player.injury?.designation ?? "",
        description: player.injury?.description ?? null,
      }));
  }

  /**
   * The draft board.
   *
   * One call returns every ranked player, dated. This is what supplies
   * `DraftablePlayer.rank`.
   */
  async listAdp(rankingType = "PPR"): Promise<AdpBoard> {
    const raw = await this.client.get<{
      adpDate?: string;
      adpType?: string;
      adpList?: {
        playerID?: string;
        longName?: string;
        overallADP?: string;
        posADP?: string;
      }[];
    }>("getNFLADP", { adpType: rankingType });

    const entries: AdpEntry[] = [];

    for (const entry of raw.adpList ?? []) {
      if (!entry.playerID) continue;

      // "3.2" -> 3200. Parsed as a decimal then scaled, because ADP is
      // genuinely fractional — unlike stat values, which are whole units.
      const adp = Number.parseFloat(entry.overallADP ?? "");
      if (!Number.isFinite(adp) || adp <= 0) continue;

      entries.push({
        externalRef: entry.playerID,
        fullName: entry.longName ?? "",
        overallMilli: Math.round(adp * 1000),
        positionRank: entry.posADP ?? null,
      });
    }

    return {
      // Tank01 stamps YYYYMMDD.
      asOf: formatAdpDate(raw.adpDate),
      rankingType: raw.adpType ?? rankingType,
      entries,
    };
  }

  /**
   * Projected season totals, in one call.
   *
   * **No `week` parameter.** That is what makes it a season aggregate rather
   * than a single week — confirmed live on 2026-08-06, where the response came
   * back with `week: "season"` and magnitudes to match (1457 receiving yards for
   * Ja'Marr Chase, not 91). Passing a week returns that week alone.
   *
   * Raw components, never Tank01's `fantasyPointsDefault`: every league scores
   * against its own frozen rules, so a provider's idea of a point is not ours.
   */
  async listSeasonProjections(season: number): Promise<readonly ProviderProjection[]> {
    const raw = await this.client.get<RawProjectionsBody>("getNFLProjections", {
      archiveSeason: String(season),
    });

    if (!isSeasonAggregate(raw)) {
      throw new ProviderError(
        `Expected season projections but got week ${String(raw.week)}. ` +
          `getNFLProjections must be called with no week parameter.`,
        this.name,
      );
    }

    return parseSeasonProjections(raw, DST_REF_PREFIX);
  }

  /**
   * Projections for **one week**, which is what filling a lineup needs.
   *
   * A season total cannot answer "who scores most this Sunday": a player on bye
   * projects zero for the week and entirely unchanged for the season. Same
   * endpoint, same parser — the only difference is the `week` parameter and
   * which shape comes back.
   *
   * The guard is the mirror of the season one and matters for the same reason.
   * Tank01 answers a bad week with the season aggregate rather than an error, so
   * without it a typo'd week would silently fill every lineup from season totals
   * while appearing to work.
   */
  async listWeekProjections(
    season: number,
    week: number,
  ): Promise<readonly ProviderProjection[]> {
    const raw = await this.client.get<RawProjectionsBody>("getNFLProjections", {
      archiveSeason: String(season),
      week: String(week),
    });

    if (isSeasonAggregate(raw)) {
      throw new ProviderError(
        `Asked for week ${week} projections and got the season aggregate. ` +
          `Filling a lineup from season totals would look like it worked.`,
        this.name,
      );
    }

    return parseSeasonProjections(raw, DST_REF_PREFIX);
  }

  /** Bye weeks by team abbreviation, for a season. Free with the roster sync. */
  async listByeWeeks(season: number): Promise<ReadonlyMap<string, number>> {
    const teams = await this.client.get<RawTeam[]>("getNFLTeams");
    const byes = new Map<string, number>();

    for (const team of teams) {
      const week = parseStatValue(team.byeWeeks?.[String(season)]?.[0]);
      if (team.teamAbv && week !== null) byes.set(team.teamAbv, week);
    }

    return byes;
  }
}

/** `"20260805"` -> `"2026-08-05"`. Falls back to today if absent or malformed. */
function formatAdpDate(raw: string | undefined): string {
  if (raw && /^\d{8}$/.test(raw)) {
    return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  }
  return new Date().toISOString().slice(0, 10);
}
