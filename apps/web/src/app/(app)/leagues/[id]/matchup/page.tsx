import { notFound } from "next/navigation";
import { leagueReadAccess } from "@/lib/visibility";
import { chromeProps } from "@/lib/chrome";
import { LeagueChrome } from "@/components/LeagueChrome";
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

  // A private league reports nothing about how it is going to a non-member.
  // `notFound` rather than a notice: a "this league is private" page confirms
  // the league exists, which is the fact an unguessable id is protecting.
  if (!(await leagueReadAccess(id)).ok) notFound();

  // After the gate, never before: the chrome carries the league's name, size and
  // rules hash, which is exactly what a private league owes a stranger none of.
  const chrome = await chromeProps(id);

  const stored = await getLeagueRules(client, id);
  if (!stored) notFound();

  const user = await currentUser();

  return (
    <div className="space-y-6">
      {chrome && <LeagueChrome {...chrome} active="/matchup" />}
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Scoreboard</h1>
        <p className="text-sm text-nocturne-neutral-500">
          Scored live from the same rules that decide the standings. A week is final{" "}
          {stored.rules.settlement.standardFinalizationHours} hours after its last kickoff —{" "}
          {stored.rules.settlement.payingFinalizationHours} for weeks that pay, because official
          stat corrections arrive for up to a week.
        </p>
      </header>

      {user ? (
        <Scoreboard leagueId={league.id} />
      ) : (
        <section className="space-y-3 rounded border border-nocturne-neutral-900 p-6">
          <p className="text-sm text-nocturne-neutral-400">Sign in to see your matchup.</p>
          <a
            href={`/signin?next=${encodeURIComponent(`/leagues/${id}/matchup`)}`}
            className="inline-block rounded rounded-[4px] border border-nocturne-accent px-4 py-2 text-[13.5px] text-nocturne-accent-200 transition-colors hover:bg-nocturne-accent/10"
          >
            Sign in
          </a>
        </section>
      )}
    </div>
  );
}
