import { notFound } from "next/navigation";
import { leagueReadAccess } from "@/lib/visibility";
import { chromeProps } from "@/lib/chrome";
import { LeagueChrome } from "@/components/LeagueChrome";
import { computeStandings, consolationField, playoffField } from "@rostr/core";
import type { StandingsRow } from "@rostr/core";
import { getLeagueRules, loadWeekResults, teamForUser } from "@rostr/db";
import { db } from "@/lib/db";
import { currentUser } from "@/lib/session";

const points = (milli: number): string => (milli / 1000).toFixed(1);

/** "7-3-1", ties dropped when there are none — nobody writes 7-3-0. */
function record(row: StandingsRow): string {
  return row.ties > 0 ? `${row.wins}-${row.losses}-${row.ties}` : `${row.wins}-${row.losses}`;
}

const TIEBREAKER_LABELS: Record<string, string> = {
  WIN_PCT: "record",
  POINTS_FOR: "points for",
  HEAD_TO_HEAD: "head-to-head",
  POINTS_AGAINST: "points against",
  LOWEST_TEAM_ID: "team ID",
};

export default async function StandingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const client = db();

  const [league] = await client.query<{ id: string; name: string; state: string }>(
    "SELECT id, name, state FROM leagues WHERE id = $1",
    [id],
  );
  if (!league) notFound();

  // A private league reports nothing about how it is going to a non-member.
  // `notFound` rather than a notice: a "this league is private" page confirms
  // the league exists, which is the fact an unguessable id is protecting.
  if (!(await leagueReadAccess(id)).ok) notFound();

  // After the gate, never before: the chrome carries the league's name, size and
  // rules hash, which is exactly what a private league owes a stranger none of.
  const chrome = await chromeProps(id);

  const stored = await getLeagueRules(client, id);
  if (!stored) notFound();

  const teams = await client.query<{ id: string; name: string; is_bot: boolean }>(
    "SELECT id, name, is_bot FROM teams WHERE league_id = $1 ORDER BY slot",
    [id],
  );

  const results = await loadWeekResults(client, id, stored.rules.schedule.regularSeasonWeeks);

  const user = await currentUser();
  const mine = user ? await teamForUser(client, id, user.id) : null;

  const standings = computeStandings(
    teams.map((team) => team.id),
    results,
    stored.rules.schedule.tiebreakers,
  );

  const byId = new Map(teams.map((team) => [team.id, team]));
  const playoffTeams = stored.rules.schedule.playoffTeams;
  const weeksPlayed = results.length === 0 ? 0 : Math.max(...results.map((r) => r.week));

  const Table = ({ rows, caption }: { rows: readonly StandingsRow[]; caption: string }) => (
    <section className="space-y-2">
      <h2 className="text-sm font-medium text-nocturne-neutral-400">{caption}</h2>
      <ul className="divide-y divide-nocturne-neutral-900 rounded border border-nocturne-neutral-900">
        {rows.map((row) => {
          const team = byId.get(row.teamId);
          return (
            <li
              key={row.teamId}
              className={`flex items-center gap-3 px-4 py-2.5 text-sm ${
                row.teamId === mine?.teamId ? "border border-nocturne-accent/5" : ""
              }`}
            >
              <span className="w-6 text-xs text-nocturne-neutral-600 tabular-nums">
                {row.seed}
              </span>
              <span className="min-w-0 flex-1 truncate">
                {team?.name ?? row.teamId}
                {team?.is_bot && (
                  <span className="ml-2 text-xs text-nocturne-neutral-600">bot</span>
                )}
              </span>

              {/*
                Which tiebreaker separated this team from the one above. "Seventh
                on points for" is a different feeling from just "seventh", and it
                is the one place a manager can see the chain actually applied.
              */}
              {row.decidedBy && (
                <span className="hidden text-xs text-nocturne-neutral-600 sm:inline">
                  on {TIEBREAKER_LABELS[row.decidedBy] ?? row.decidedBy.toLowerCase()}
                </span>
              )}

              <span className="w-16 text-right tabular-nums">{record(row)}</span>
              <span className="w-16 text-right tabular-nums" title="Points for">
                {points(row.milliPointsFor)}
              </span>
              <span
                className="hidden w-16 text-right text-nocturne-neutral-600 tabular-nums sm:inline"
                title="Points against"
              >
                {points(row.milliPointsAgainst)}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );

  return (
    <div className="space-y-6">
      {chrome && <LeagueChrome {...chrome} active="/standings" />}
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Standings</h1>
        <p className="text-sm text-nocturne-neutral-500">
          {weeksPlayed === 0
            ? "No weeks scored yet."
            : `Through week ${weeksPlayed} of ${stored.rules.schedule.regularSeasonWeeks}.`}
        </p>
      </header>

      <Table
        rows={playoffField(standings, playoffTeams)}
        caption={`Playoff places — top ${playoffTeams}, seeds 1–${stored.rules.schedule.byeSeeds} get a bye`}
      />

      <Table rows={consolationField(standings, playoffTeams)} caption="Consolation bracket" />

      <p className="text-xs text-nocturne-neutral-600">
        The consolation bracket is still played. Missing the playoffs is not the end of the
        season.
      </p>
    </div>
  );
}
