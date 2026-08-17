import { notFound } from "next/navigation";
import { leagueReadAccess } from "@/lib/visibility";
import { getLeagueRules } from "@rostr/db";
import { TradeBlock } from "@/components/TradeBlock";
import { db } from "@/lib/db";
import { currentUser } from "@/lib/session";

export default async function TradesPage({ params }: { params: Promise<{ id: string }> }) {
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
  const trades = stored.rules.trades;

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <a
          href={`/leagues/${id}`}
          className="text-xs text-nocturne-neutral-600 hover:text-nocturne-text"
        >
          ← {league.name}
        </a>
        <h1 className="text-2xl font-semibold tracking-tight">Trades</h1>
        <p className="text-sm text-nocturne-neutral-500">
          Deadline: end of week {trades.deadlineWeek}. An accepted trade waits{" "}
          {trades.vetoWindowHours} hours before it executes, and {trades.vetoNumerator}/
          {trades.vetoDenominator} of the managers not in it can block it in that time.
        </p>
        <p className="text-xs text-nocturne-neutral-600">
          Nobody can force a trade through or reverse one — not the commissioner, not us.
        </p>
      </header>

      {user ? (
        <TradeBlock leagueId={league.id} />
      ) : (
        <section className="space-y-3 rounded border border-nocturne-neutral-900 p-6">
          <p className="text-sm text-nocturne-neutral-400">
            Sign in to propose and vote on trades.
          </p>
          <a
            href={`/signin?next=${encodeURIComponent(`/leagues/${id}/trades`)}`}
            className="inline-block rounded rounded-[4px] border border-nocturne-accent px-4 py-2 text-[13.5px] text-nocturne-accent-200 transition-colors hover:bg-nocturne-accent/10"
          >
            Sign in
          </a>
        </section>
      )}
    </div>
  );
}
