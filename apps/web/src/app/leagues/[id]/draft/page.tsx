import { notFound } from "next/navigation";
import { DraftRoom } from "@/components/DraftRoom";
import { db } from "@/lib/db";

export default async function DraftPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const [league] = await db().query<{ id: string; name: string }>(
    "SELECT id, name FROM leagues WHERE id = $1",
    [id],
  );
  if (!league) notFound();

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <a href={`/leagues/${id}`} className="text-xs text-white/40 hover:text-white">
          ← {league.name}
        </a>
        <h1 className="text-2xl font-semibold tracking-tight">Draft</h1>
      </header>

      <DraftRoom leagueId={league.id} leagueName={league.name} />
    </div>
  );
}
