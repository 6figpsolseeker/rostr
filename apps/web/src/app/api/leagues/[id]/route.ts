import { NextResponse } from "next/server";
import { getLeagueRules } from "@rostr/db";
import { db } from "@/lib/db";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const client = db();

  const [league] = await client.query<{
    id: string;
    name: string;
    season: number;
    state: string;
    visibility: string;
    rules_hash: string;
    rules_uri: string | null;
  }>(
    `SELECT id, name, season, state, visibility, rules_hash, rules_uri
       FROM leagues WHERE id = $1`,
    [id],
  );

  if (!league) {
    return NextResponse.json({ error: "League not found" }, { status: 404 });
  }

  const stored = await getLeagueRules(client, id);
  if (!stored) {
    return NextResponse.json({ error: "League has no stored rules" }, { status: 500 });
  }

  const teams = await client.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM teams WHERE league_id = $1",
    [id],
  );

  return NextResponse.json({
    id: league.id,
    name: league.name,
    season: league.season,
    state: league.state,
    visibility: league.visibility,
    rulesHash: league.rules_hash,
    rulesUri: league.rules_uri,
    teamCount: Number(teams[0]?.count ?? 0),
    rules: stored.rules,
  });
}
