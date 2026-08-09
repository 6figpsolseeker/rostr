import { notFound } from "next/navigation";
import { getLeagueRules } from "@rostr/db";
import { Scoreboard } from "@/components/Scoreboard";
import { db } from "@/lib/db";
import { currentUser } from "@/lib/session";

export default async function MatchupPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const client = db();

  const [league] = await client.query<{ id: string; name: string }>(
    "SELECT id, name FROM leagues WHERE id = $1",
    [id],
  );
  if (!league) notFound();

  const stored = await getLeagueRules(client, id);
  if (!stored) notFound();

  const user = await currentUser();

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <a href={`/leagues/${id}`} className="text-xs text-white/40 hover:text-white">
          ← {league.name}
        </a>
        <h1 className="text-2xl font-semibold tracking-tight">Scoreboard</h1>
        <p className="text-sm text-white/50">
          Scored live from the same rules that decide the standings. A week is final{" "}
          {stored.rules.settlement.standardFinalizationHours} hours after its last kickoff —{" "}
          {stored.rules.settlement.payingFinalizationHours} for weeks that pay, because official
          stat corrections arrive for up to a week.
        </p>
      </header>

      {user ? (
        <Scoreboard leagueId={league.id} />
      ) : (
        <section className="space-y-3 rounded border border-white/10 p-6">
          <p className="text-sm text-white/60">Sign in to see your matchup.</p>
          <a
            href={`/signin?next=${encodeURIComponent(`/leagues/${id}/matchup`)}`}
            className="inline-block rounded bg-[--color-turf] px-4 py-2 text-sm font-medium text-black"
          >
            Sign in
          </a>
        </section>
      )}
    </div>
  );
}
