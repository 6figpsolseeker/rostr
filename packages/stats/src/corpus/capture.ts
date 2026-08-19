/**
 * Filling the corpus. **The only part of it that touches the network.**
 *
 * ## Why capture is a command and the check is a test
 *
 * `corpus.test.ts` runs inside `pnpm test`: offline, no credentials, no metered
 * calls. That constraint is not a convenience. `CLAUDE.md` says the core stays
 * testable without a single credential, CI has no Tank01 key, and a Tank01 call
 * costs money per request — so a suite that reached for the provider would be
 * unrunnable on CI and self-throttling everywhere else.
 *
 * **There is deliberately no live tier**, and that is a decision rather than an
 * omission. A test that re-fetches every game and compares it against frozen
 * expectations pits a fixed file against a moving upstream: a provider
 * backfilling a stat correction, renaming a field, or reserialising a play turns
 * the suite red for something that is not our bug, and the only response
 * available to whoever is on shift is to regenerate — which builds precisely the
 * regenerate-to-green reflex this corpus exists to prevent. Provider drift is
 * real and is caught by capturing a *new* game and reading the diff, which is a
 * deliberate act with a human attached to it.
 *
 * ## What one game costs
 *
 * **One metered Tank01 call, once, ever.** {@link captureGame} skips the box
 * score when the fixture is already on disk, so re-running to backfill the free
 * sources costs nothing. ESPN and Sleeper are both free and unauthenticated.
 *
 * ## What is trimmed, and why trimming is safe here
 *
 * Sleeper's player directory is ~14 MB and its weekly stat file covers the whole
 * league. Both are cut down to the players in this one game before being written.
 * That is a lossy transformation of a provider response, which is normally the
 * thing not to do — it is acceptable only because the trimmed columns are named
 * in code (`espn_id`, and the stat keys `sleeper.ts` reads) and because the
 * **Tank01** response, the one under test, is written verbatim.
 */

import type { Tank01Client } from "../tank01/client.js";
import type { SleeperIdMap, SleeperStats } from "../sleeper/stats.js";

const SLEEPER_STATS = "https://api.sleeper.app/v1/stats/nfl/regular";
const SLEEPER_PLAYERS = "https://api.sleeper.app/v1/players/nfl";
const ESPN_SITE = "https://site.api.espn.com/apis/site/v2/sports/football/nfl";

/**
 * Sleeper's abbreviation where it differs from Tank01's.
 *
 * Exactly one differs, checked by listing all 32 D/ST keys in a live weekly
 * response against Tank01's `DST` blocks: Washington is `WSH` to Tank01 and ESPN
 * and `WAS` to Sleeper. Everything else is identical, including `LAR`, `LV` and
 * `JAX`, which are the ones that usually vary between feeds.
 *
 * A table rather than a fuzzy match, because a D/ST joined to the wrong team is
 * a swing between two rosters — the mistake `box-score.ts` has made twice.
 */
const SLEEPER_TEAM_ALIASES: Readonly<Record<string, string>> = { WSH: "WAS" };

export const sleeperTeam = (teamAbv: string): string =>
  SLEEPER_TEAM_ALIASES[teamAbv] ?? teamAbv;

/** The ESPN fixture: the event it came from, and the two fields compared. */
export interface EspnFixture {
  readonly gameRef: string;
  readonly eventId: string;
  readonly scoringPlays: readonly {
    readonly text: string;
    readonly abbreviation: string | null;
  }[];
}

/** The Sleeper fixture: one week, cut to this game's players and two units. */
export interface SleeperFixture {
  readonly gameRef: string;
  readonly season: number;
  readonly week: number;
  /** Keyed by Sleeper player id, which for a D/ST is the team abbreviation. */
  readonly stats: Readonly<Record<string, SleeperStats>>;
}

interface RawBox {
  gameID?: string;
  playerStats?: Record<string, { playerID?: string; longName?: string }>;
  DST?: Record<string, { teamAbv?: string } | undefined>;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  return (await response.json()) as T;
}

/** The two team abbreviations in a Tank01 box score, home and away. */
export function teamsOf(box: unknown): readonly string[] {
  const dst = (box as RawBox).DST ?? {};
  return (["home", "away"] as const)
    .map((side) => dst[side]?.teamAbv ?? "")
    .filter((abv): abv is string => abv.length > 0);
}

/**
 * ESPN's event id for a Tank01 game.
 *
 * Resolved from the date embedded in the `gameID` and the two team
 * abbreviations, rather than stored by hand in the manifest: a hand-copied id is
 * a field that can be wrong in a way nothing checks, and ESPN's scoreboard is
 * free.
 *
 * The date query is by **Eastern** game date, which is what a Tank01 `gameID`
 * carries too — a Sunday-night kickoff appears under the Sunday even though its
 * UTC timestamp is the Monday.
 */
export async function resolveEspnEvent(gameRef: string): Promise<string> {
  const date = gameRef.slice(0, 8);
  const teams = new Set(gameRef.slice(9).split("@"));

  const board = await getJson<{
    events?: {
      id: string;
      competitions: { competitors: { team: { abbreviation: string } }[] }[];
    }[];
  }>(`${ESPN_SITE}/scoreboard?dates=${date}`);

  for (const event of board.events ?? []) {
    const abbreviations = (event.competitions[0]?.competitors ?? []).map(
      (competitor) => competitor.team.abbreviation,
    );
    if (abbreviations.length === teams.size && abbreviations.every((abv) => teams.has(abv))) {
      return event.id;
    }
  }

  throw new Error(`no ESPN event on ${date} between ${[...teams].join(" and ")}`);
}

/** ESPN's scoring plays for one event, trimmed to text and type abbreviation. */
export async function fetchEspnScoringPlays(
  gameRef: string,
  eventId: string,
): Promise<EspnFixture> {
  const summary = await getJson<{
    scoringPlays?: { text?: string; scoringType?: { abbreviation?: string } }[];
  }>(`${ESPN_SITE}/summary?event=${eventId}`);

  return {
    gameRef,
    eventId,
    scoringPlays: (summary.scoringPlays ?? []).map((play) => ({
      text: play.text ?? "",
      abbreviation: play.scoringType?.abbreviation ?? null,
    })),
  };
}

/**
 * Sleeper's week, cut to the players in this game.
 *
 * The subject set is **Tank01's roster for the game**, not Sleeper's idea of who
 * plays for these teams. Sleeper's directory carries a player's *current* team,
 * which for a 2024 fixture is frequently a different one, so selecting by team
 * would quietly drop anyone who has since moved and silently include people who
 * were not there.
 */
export async function fetchSleeperWeek(
  box: unknown,
  idMap: SleeperIdMap,
  season: number,
  week: number,
): Promise<SleeperFixture> {
  const all = await getJson<Record<string, SleeperStats | null>>(
    `${SLEEPER_STATS}/${season}/${week}`,
  );

  const wanted = new Set<string>();
  for (const playerID of Object.keys((box as RawBox).playerStats ?? {})) {
    const mapped = idMap[playerID];
    if (mapped) wanted.add(mapped.id);
  }
  for (const teamAbv of teamsOf(box)) wanted.add(sleeperTeam(teamAbv));

  const stats: Record<string, SleeperStats> = {};
  for (const id of [...wanted].sort()) {
    const line = all[id];
    if (line) stats[id] = line;
  }

  return { gameRef: String((box as RawBox).gameID ?? ""), season, week, stats };
}

/**
 * The Tank01 -> Sleeper player join, trimmed to the corpus.
 *
 * ## `espn_id` looked like the join and is not
 *
 * Tank01's `playerID` **is** the ESPN athlete id, and Sleeper's directory
 * carries an `espn_id` column, so the obvious join is `playerID -> espn_id ->
 * player_id` with no name matching anywhere. It was built that way first and it
 * fails: **Sleeper stopped populating `espn_id` for players entering the league
 * from about 2023.** 6,736 of their 12,221 rows carry one, and the ones that do
 * not include Puka Nacua, Jaxon Smith-Njigba and most of two draft classes —
 * roughly half of every box score, silently unjoined, which is a comparison that
 * looks green because it never runs.
 *
 * ## So the join comes from Tank01, and the name check comes from Sleeper
 *
 * `getNFLPlayerList` carries `sleeperBotID` beside `playerID` — one metered
 * call for the whole league — which is the join the original full-season sweep
 * used. The cost of taking it from the provider is that the provider is now
 * asserting the identity, so a mismapped row would compare two different people
 * and report a disagreement about the wrong thing.
 *
 * **That is what the surname check is for.** Every join is confirmed against the
 * name Sleeper's own directory gives for the id, and a pair whose surnames
 * disagree is dropped and reported rather than written. It costs one free fetch
 * and turns "Tank01 says these are the same person" into something checked.
 *
 * One shared fixture rather than one per game — the same people recur — and
 * merged into whatever is on disk rather than replaced, so adding a game cannot
 * drop the entries an earlier one depends on.
 */
export async function fetchSleeperIdMap(
  client: Tank01Client,
  boxes: readonly unknown[],
  existing: SleeperIdMap,
): Promise<{ map: SleeperIdMap; rejected: readonly string[] }> {
  const [directory, roster] = await Promise.all([
    getJson<Record<string, { player_id?: string; full_name?: string } | null>>(SLEEPER_PLAYERS),
    client.get<{ playerID?: string; sleeperBotID?: string; longName?: string }[]>(
      "getNFLPlayerList",
    ),
  ]);

  const sleeperById = new Map(
    Object.entries(directory)
      .filter(([, entry]) => !!entry?.player_id)
      .map(([, entry]) => [entry?.player_id as string, entry?.full_name ?? ""]),
  );

  const wanted = new Set(
    boxes.flatMap((box) => Object.keys((box as RawBox).playerStats ?? {})),
  );

  const merged: Record<string, { id: string; name: string }> = { ...existing };
  const rejected: string[] = [];

  for (const player of roster) {
    if (!player.playerID || !player.sleeperBotID || !wanted.has(player.playerID)) continue;

    const theirName = sleeperById.get(player.sleeperBotID);
    if (theirName === undefined) {
      // Reported rather than skipped. A `sleeperBotID` pointing at nobody in
      // Sleeper's directory is a different fact from a surname mismatch, and
      // both end the same way: a player who is compared against nothing. The
      // caller prints these under "Never silent", which was not true of this
      // branch.
      rejected.push(
        `${player.playerID} "${player.longName ?? "?"}" -> sleeper ${player.sleeperBotID} ` +
          `— no such id in Sleeper's directory, so the pair was not written`,
      );
      continue;
    }

    if (surname(theirName) !== surname(player.longName ?? "")) {
      rejected.push(
        `${player.playerID} "${player.longName ?? "?"}" -> sleeper ${player.sleeperBotID} ` +
          `"${theirName}" — surnames disagree, so the pair was not written`,
      );
      continue;
    }

    merged[player.playerID] = { id: player.sleeperBotID, name: theirName };
  }

  return {
    map: Object.fromEntries(Object.entries(merged).sort(([a], [b]) => (a < b ? -1 : 1))),
    rejected,
  };
}

/** Last word of a name, lower-cased, suffixes and punctuation removed. */
function surname(name: string): string {
  const words = name
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, "")
    .replace(/[.'’`-]/g, "")
    .trim()
    .split(/\s+/);
  return words[words.length - 1] ?? "";
}

/** One metered call. Skipped entirely when the fixture is already on disk. */
export async function fetchBoxScore(client: Tank01Client, gameRef: string): Promise<unknown> {
  return client.get<unknown>("getNFLBoxScore", { gameID: gameRef });
}
