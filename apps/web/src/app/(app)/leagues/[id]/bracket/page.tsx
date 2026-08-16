import { notFound } from "next/navigation";
import { leagueReadAccess } from "@/lib/visibility";
import { getLeagueRules, loadWeekResults, playoffState } from "@rostr/db";
import type { BracketGame, BracketRound } from "@rostr/core";
import { db } from "@/lib/db";

/**
 * The bracket.
 *
 * Rendered on the server from `playoffState`, which rebuilds it from the scores
 * every time. There is nothing to poll and nothing cached: the page cannot show
 * a bracket that disagrees with the results it came from, because it has no
 * other source.
 *
 * Rounds that have not been reached are absent rather than drawn empty. Who
 * plays in Week 16 genuinely is not known until Week 15 is scored — the top seed
 * takes whichever survivor is seeded lowest — so a greyed-out fixture would be
 * an invention.
 */
export default async function BracketPage({ params }: { params: Promise<{ id: string }> }) {
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

  const stored = await getLeagueRules(client, id);
  if (!stored) notFound();

  const teams = await client.query<{ id: string; name: string }>(
    "SELECT id, name FROM teams WHERE league_id = $1",
    [id],
  );
  const names = new Map(teams.map((team) => [team.id, team.name]));
  const nameOf = (teamId: string | null): string =>
    teamId === null ? "—" : (names.get(teamId) ?? "Unknown");

  const [unfinished] = await client.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM matchups
      WHERE league_id = $1 AND phase = 'REGULAR' AND finalized_at IS NULL`,
    [id],
  );
  const seasonOver = Number(unfinished?.count ?? 0) === 0;

  const state = seasonOver ? await playoffState(client, id) : null;

  // **Deliberately unfiltered, unlike the bracket above it.** The ladder advances
  // only on finalised results; these scores are live, so a played-but-not-yet-final
  // game shows its real score with no winner marked. That gap is the correction
  // window, and the screen says so rather than looking broken.
  const scores = new Map<string, { home: number; away: number }>();
  for (const phase of ["PLAYOFF", "CONSOLATION"] as const) {
    for (const row of await loadWeekResults(client, id, 99, phase)) {
      if (row.awayTeamId === null) continue;
      scores.set(`${row.week}:${row.homeTeamId}:${row.awayTeamId}`, {
        home: row.homeMilliPoints,
        away: row.awayMilliPoints,
      });
      scores.set(`${row.week}:${row.awayTeamId}:${row.homeTeamId}`, {
        home: row.awayMilliPoints,
        away: row.homeMilliPoints,
      });
    }
  }

  // Every game in the last laid round has a live score, but the ladder has not
  // resolved — so the week is played and not yet final. Derived from the same two
  // sources the screen already holds rather than a third query, so it cannot
  // disagree with what is rendered beside it.
  const lastRound = state?.playoffs?.bracket.rounds.at(-1);
  const awaitingFinal =
    !!lastRound &&
    lastRound.games.length > 0 &&
    lastRound.games.every((game) =>
      scores.has(`${game.week}:${game.homeTeamId}:${game.awayTeamId}`),
    ) &&
    lastRound.survivors === null;

  const Game = ({ game }: { game: BracketGame }) => {
    const score = scores.get(`${game.week}:${game.homeTeamId}:${game.awayTeamId}`);
    const won = (teamId: string) => game.winnerTeamId === teamId;

    return (
      <li className="rounded border border-white/10 px-4 py-3 text-sm">
        <div className="mb-1 flex items-baseline justify-between text-xs text-white/40">
          <span>{game.label}</span>
          <span>Week {game.week}</span>
        </div>
        {[
          { teamId: game.homeTeamId, points: score?.home },
          { teamId: game.awayTeamId, points: score?.away },
        ].map((side) => (
          <div key={side.teamId} className="flex items-baseline gap-3">
            <span className={won(side.teamId) ? "flex-1 font-medium" : "flex-1 text-white/60"}>
              {nameOf(side.teamId)}
            </span>
            <span className="tabular-nums text-white/50">
              {side.points === undefined ? "—" : (side.points / 1000).toFixed(1)}
            </span>
          </div>
        ))}
        {game.decidedBySeed && (
          <p className="mt-1 text-xs text-amber-300/70">
            Level on points — the higher seed advances.
          </p>
        )}
      </li>
    );
  };

  const Round = ({ round }: { round: BracketRound }) => (
    <section className="space-y-2">
      <h3 className="text-sm font-medium text-white/70">
        {round.label}
        <span className="ml-2 text-xs font-normal text-white/30">Week {round.week}</span>
      </h3>
      <ul className="space-y-2">
        {round.games.map((game) => (
          <Game key={`${game.week}:${game.homeTeamId}`} game={game} />
        ))}
      </ul>
      {round.byes.length > 0 && (
        <p className="text-xs text-white/40">
          Bye: {round.byes.map((bye) => `${nameOf(bye.teamId)} (${bye.seed})`).join(", ")}
        </p>
      )}
    </section>
  );

  return (
    <div className="space-y-8">
      <header className="space-y-1">
        <a href={`/leagues/${id}`} className="text-xs text-white/40 hover:text-white">
          ← {league.name}
        </a>
        <h1 className="text-2xl font-semibold tracking-tight">Bracket</h1>
        <p className="text-sm text-white/50">
          Top {stored.rules.schedule.playoffTeams} qualify; the top{" "}
          {stored.rules.schedule.byeSeeds} sit out the first round. Every round reseeds, so the
          best remaining seed always draws the worst.
        </p>
      </header>

      {!seasonOver && (
        <p className="rounded border border-white/10 px-4 py-3 text-sm text-white/60">
          The bracket is drawn when the regular season finishes. Seeding it early would give a
          bracket that changes under the teams in it.
        </p>
      )}

      {/*
        The gap between "the final was played" and "the final is final".

        The bracket advances only on finalised results, and the championship week
        waits 168 hours for official stat corrections. So for seven days the
        screen holds a played game with a real score and no champion — which
        reads as a broken page unless it says otherwise. It is not a delay in
        deciding; it is the week not being decided yet.
      */}
      {!state?.champion && awaitingFinal && (
        <section className="rounded border border-white/10 px-4 py-3">
          <p className="text-sm text-white/70">Waiting on the correction window.</p>
          <p className="mt-1 text-xs text-white/50">
            The games are played, but official stat corrections arrive for up to seven days and
            this week pays out. No champion is named until the week is final — which is the
            point: a result that can still change is not a result.
          </p>
        </section>
      )}

      {state?.champion && (
        <section className="rounded border border-[--color-turf]/30 bg-[--color-turf]/5 px-4 py-3">
          <p className="text-sm">
            <strong>{nameOf(state.champion)}</strong> are champions.
          </p>
          <p className="mt-1 text-xs text-white/50">
            Runner-up {nameOf(state.runnerUp)}
            {state.thirdPlace ? `, third ${nameOf(state.thirdPlace)}` : ""}
            {state.consolationWinner ? `, consolation ${nameOf(state.consolationWinner)}` : ""}.
            Derived from the scores — nobody declared it.
          </p>
        </section>
      )}

      {state?.playoffs && (
        <div className="space-y-6">
          <h2 className="text-sm font-medium uppercase tracking-wide text-white/50">
            Playoffs
          </h2>
          {state.playoffs.bracket.rounds.map((round) => (
            <Round key={round.round} round={round} />
          ))}
          {state.playoffs.bracket.thirdPlaceGame && (
            <section className="space-y-2">
              <h3 className="text-sm font-medium text-white/70">Third place</h3>
              <ul className="space-y-2">
                <Game game={state.playoffs.bracket.thirdPlaceGame} />
              </ul>
            </section>
          )}
        </div>
      )}

      {state?.consolation && (
        <div className="space-y-6">
          <h2 className="text-sm font-medium uppercase tracking-wide text-white/50">
            Consolation
          </h2>
          <p className="text-xs text-white/40">
            It is played but unpaid. An eliminated team still has something to play for, which
            is the whole reason it exists.
          </p>
          {state.consolation.bracket.rounds.map((round) => (
            <Round key={round.round} round={round} />
          ))}
        </div>
      )}
    </div>
  );
}
