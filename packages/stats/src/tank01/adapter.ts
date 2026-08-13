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

interface RawPlayer {
  playerID?: string;
  longName?: string;
  pos?: string;
  team?: string;
  isFreeAgent?: string;
  injury?: { designation?: string; description?: string };
}

interface RawTeam {
  teamAbv?: string;
  teamCity?: string;
  teamName?: string;
  byeWeeks?: Record<string, string[]>;
}

interface RawGame {
  gameID?: string;
  gameWeek?: string;
  home?: string;
  away?: string;
  gameTime_epoch?: string;
  gameStatus?: string;
}

/** Tank01's game status wording to ours. */
function mapGameStatus(status: string | undefined): ProviderGame["status"] {
  switch ((status ?? "").toLowerCase()) {
    case "final":
    case "final/ot":
      return "FINAL";
    case "in progress":
    case "live - in progress":
      return "IN_PROGRESS";
    case "postponed":
      return "POSTPONED";
    case "cancelled":
    case "canceled":
      return "CANCELLED";
    default:
      return "SCHEDULED";
  }
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
      });
    }

    return players;
  }

  async listGames(season: number, week?: number): Promise<readonly ProviderGame[]> {
    const params: Record<string, string> = { season: String(season), seasonType: "reg" };
    if (week !== undefined) params["week"] = String(week);

    const raw = await this.client.get<RawGame[]>("getNFLGamesForWeek", params);

    return raw
      .filter((game): game is RawGame & { gameID: string } => Boolean(game.gameID))
      .map((game) => {
        const kickoff = Number.parseFloat(game.gameTime_epoch ?? "0");

        return {
          externalRef: game.gameID,
          season,
          // "Week 1" -> 1
          week: Number.parseInt((game.gameWeek ?? "").replace(/\D+/g, ""), 10) || (week ?? 0),
          homeTeamRef: game.home ?? "",
          awayTeamRef: game.away ?? "",
          kickoffAt: Number.isFinite(kickoff) ? Math.round(kickoff) : 0,
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
