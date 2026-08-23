import { getLeagueRules } from "@rostr/db";
import { db } from "@/lib/db";
import { leagueNavOpen } from "@/lib/visibility";

/**
 * Everything `LeagueChrome` needs, loaded once.
 *
 * **Six of the eight league screens had no chrome at all.** Lineup, players,
 * trades, matchup, standings and bracket each rendered a bare "← league name"
 * link instead, so clicking into any of them ended the nav: getting from your
 * lineup to trades meant going back first, on every screen, all season.
 *
 * They did not have the parts. Each loads `id, name` and nothing else, while the
 * chrome wants the rules hash and a subtitle — so adding it page by page meant
 * six copies of the same query and six chances for the subtitle to disagree
 * about what a league is. `CLAUDE.md`'s recurring lesson is that a fact authored
 * twice diverges; this is the same fact authored six times.
 *
 * **The subtitle is composed here on purpose.** The league home built it inline
 * and it is the one string on the chrome that can lie — a stale team count or a
 * wrong state reads as authoritative because it sits beside the rules hash.
 */
export interface ChromeProps {
  readonly leagueId: string;
  readonly name: string;
  readonly subtitle: string;
  readonly rulesHash: string;
  readonly navOpen: boolean;
}

/**
 * `null` when the league does not exist, so the caller can `notFound()`.
 *
 * It answers nothing about *visibility* — `leagueReadAccess` is that check and
 * every caller runs it already. Folding the two together would make one
 * function decide both "is there a league" and "may you see it", and the second
 * has to 404 rather than 403 for reasons `visibility.ts` records.
 */
export async function chromeProps(leagueId: string): Promise<ChromeProps | null> {
  const client = db();

  const [league] = await client.query<{
    id: string;
    name: string;
    season: number;
    state: string;
  }>("SELECT id, name, season, state FROM leagues WHERE id = $1", [leagueId]);
  if (!league) return null;

  const stored = await getLeagueRules(client, leagueId);
  if (!stored) return null;

  const [count] = await client.query<{ taken: number }>(
    "SELECT count(*)::int AS taken FROM teams WHERE league_id = $1",
    [leagueId],
  );
  const taken = Number(count?.taken ?? 0);

  return {
    leagueId: league.id,
    name: league.name,
    subtitle: leagueSubtitle({
      season: league.season,
      taken,
      maxTeams: stored.rules.league.maxTeams,
      state: league.state,
    }),
    rulesHash: stored.hash,
    navOpen: await leagueNavOpen(leagueId),
  };
}

/**
 * "2026 season · 5/12 teams · forming".
 *
 * Separated from the query so it can be tested without a database — the shape
 * of the string is the part with a wrong answer worth catching, and `IN_SEASON`
 * rendering as `in_season` is exactly the kind that ships.
 */
export function leagueSubtitle(input: {
  readonly season: number;
  readonly taken: number;
  readonly maxTeams: number;
  readonly state: string;
}): string {
  const state = input.state.toLowerCase().replaceAll("_", " ");
  return `${input.season} season · ${input.taken}/${input.maxTeams} teams · ${state}`;
}
