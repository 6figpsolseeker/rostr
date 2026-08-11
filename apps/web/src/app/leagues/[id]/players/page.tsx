import { notFound } from "next/navigation";
import { leagueReadAccess } from "@/lib/visibility";
import { getLeagueRules, nextWaiverRun } from "@rostr/db";
import { PlayerMarket } from "@/components/PlayerMarket";
import { db } from "@/lib/db";
import { currentUser } from "@/lib/session";

export default async function PlayersPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const client = db();

  const [league] = await client.query<{ id: string; name: string }>(
    "SELECT id, name FROM leagues WHERE id = $1",
    [id],
  );
  if (!league) notFound();

  // A private league reports nothing about how it is going to a non-member.
  // `notFound` rather than a notice: a "this league is private" page confirms
  // the league exists, which is the fact an unguessable id is protecting.
  if (!(await leagueReadAccess(id)).ok) notFound();

  const stored = await getLeagueRules(client, id);
  if (!stored) notFound();

  const user = await currentUser();
  const nextRun = nextWaiverRun(stored.rules, new Date());

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <a href={`/leagues/${id}`} className="text-xs text-white/40 hover:text-white">
          ← {league.name}
        </a>
        <h1 className="text-2xl font-semibold tracking-tight">Players</h1>
        <p className="text-sm text-white/50">
          Next waiver run {nextRun.toLocaleString()} — claims are resolved then, by priority.
        </p>
      </header>

      {user ? (
        <PlayerMarket leagueId={league.id} />
      ) : (
        <section className="space-y-3 rounded border border-white/10 p-6">
          <p className="text-sm text-white/60">Sign in to add and drop players.</p>
          <a
            href={`/signin?next=${encodeURIComponent(`/leagues/${id}/players`)}`}
            className="inline-block rounded bg-[--color-turf] px-4 py-2 text-sm font-medium text-black"
          >
            Sign in
          </a>
        </section>
      )}
    </div>
  );
}
