import { NextResponse } from "next/server";
import { computeStandings, consolationField, playoffField } from "@rostr/core";
import { loadWeekResults } from "@rostr/db";
import { db } from "@/lib/db";
import { draftContext, DraftContextError } from "@/lib/draft-context";

/**
 * The table.
 *
 * Computed from stored results rather than kept as a running tally, so it can
 * never drift out of step with the matchups it is derived from. Cheap: a season
 * is a couple of hundred rows.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  try {
    const context = await draftContext(id);
    const client = db();

    const through = context.rules.schedule.regularSeasonWeeks;
    const results = await loadWeekResults(client, id, through);

    const teams = await client.query<{ id: string; name: string; is_bot: boolean }>(
      "SELECT id, name, is_bot FROM teams WHERE league_id = $1 ORDER BY slot",
      [id],
    );

    const standings = computeStandings(
      teams.map((team) => team.id),
      results,
      context.rules.schedule.tiebreakers,
    );

    const byId = new Map(teams.map((team) => [team.id, team]));
    const playoffTeams = context.rules.schedule.playoffTeams;

    const decorate = (rows: readonly (typeof standings)[number][]) =>
      rows.map((row) => ({
        seed: row.seed,
        teamId: row.teamId,
        name: byId.get(row.teamId)?.name ?? row.teamId,
        isBot: byId.get(row.teamId)?.is_bot ?? false,
        isMine: row.teamId === context.myTeamId,
        wins: row.wins,
        losses: row.losses,
        ties: row.ties,
        games: row.games,
        milliPointsFor: row.milliPointsFor,
        milliPointsAgainst: row.milliPointsAgainst,
        // Which tiebreaker separated this team from the one above, when one did.
        // Worth showing: "you are seventh on points for" is a different feeling
        // from "you are seventh".
        decidedBy: row.decidedBy,
      }));

    return NextResponse.json({
      weeksPlayed: results.length === 0 ? 0 : Math.max(...results.map((r) => r.week)),
      playoffTeams,
      byeSeeds: context.rules.schedule.byeSeeds,
      playoffs: decorate(playoffField(standings, playoffTeams)),
      consolation: decorate(consolationField(standings, playoffTeams)),
    });
  } catch (error) {
    if (error instanceof DraftContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
