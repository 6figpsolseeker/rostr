import { notFound } from "next/navigation";
import { leagueReadAccess } from "@/lib/visibility";
import { DraftRoom } from "@/components/DraftRoom";
import { db } from "@/lib/db";

export default async function DraftPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const [league] = await db().query<{ id: string; name: string }>(
    "SELECT id, name FROM leagues WHERE id = $1",
    [id],
  );
  if (!league) notFound();

  // A private league reports nothing about how it is going to a non-member.
  // `notFound` rather than a notice: a "this league is private" page confirms
  // the league exists, which is the fact an unguessable id is protecting.
  if (!(await leagueReadAccess(id)).ok) notFound();

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <a
          href={`/leagues/${id}`}
          className="text-xs text-nocturne-neutral-600 hover:text-nocturne-text"
        >
          ← {league.name}
        </a>
        <h1 className="text-2xl font-semibold tracking-tight">Draft</h1>
      </header>

      <DraftRoom leagueId={league.id} leagueName={league.name} />
    </div>
  );
}
