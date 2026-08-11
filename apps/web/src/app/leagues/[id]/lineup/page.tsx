import { notFound } from "next/navigation";
import { leagueReadAccess } from "@/lib/visibility";
import { LineupEditor } from "@/components/LineupEditor";
import { db } from "@/lib/db";
import { currentUser } from "@/lib/session";

export default async function LineupPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ week?: string }>;
}) {
  const { id } = await params;
  const { week } = await searchParams;

  const [league] = await db().query<{ id: string; name: string }>(
    "SELECT id, name FROM leagues WHERE id = $1",
    [id],
  );
  if (!league) notFound();

  // A private league reports nothing about how it is going to a non-member.
  // `notFound` rather than a notice: a "this league is private" page confirms
  // the league exists, which is the fact an unguessable id is protecting.
  if (!(await leagueReadAccess(id)).ok) notFound();

  const user = await currentUser();
  const parsed = Number.parseInt(week ?? "1", 10);
  const current = Number.isFinite(parsed) && parsed > 0 ? parsed : 1;

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <a href={`/leagues/${id}`} className="text-xs text-white/40 hover:text-white">
          ← {league.name}
        </a>
        <h1 className="text-2xl font-semibold tracking-tight">Lineup</h1>
      </header>

      {user ? (
        <LineupEditor leagueId={league.id} week={current} />
      ) : (
        <section className="space-y-3 rounded border border-white/10 p-6">
          <p className="text-sm text-white/60">Sign in to set your lineup.</p>
          <a
            href={`/signin?next=${encodeURIComponent(`/leagues/${id}/lineup`)}`}
            className="inline-block rounded bg-[--color-turf] px-4 py-2 text-sm font-medium text-black"
          >
            Sign in
          </a>
        </section>
      )}
    </div>
  );
}
