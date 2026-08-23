import { notFound } from "next/navigation";
import { leagueReadAccess } from "@/lib/visibility";
import { chromeProps } from "@/lib/chrome";
import { LeagueChrome } from "@/components/LeagueChrome";
import { getLeagueRules, nextWaiverRun } from "@rostr/db";
import { PlayerMarket } from "@/components/PlayerMarket";
import { WaiverRunPanel } from "@/components/WaiverRunPanel";
import { draftContext } from "@/lib/draft-context";
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

  // After the gate, never before: the chrome carries the league's name, size and
  // rules hash, which is exactly what a private league owes a stranger none of.
  const chrome = await chromeProps(id);

  const stored = await getLeagueRules(client, id);
  if (!stored) notFound();

  const user = await currentUser();

  // Only to mark the caller's own rows in the run. `draftContext` derives it
  // from the session and the league's membership, never from a request — the
  // panel itself is gated at its route, so a null here dims nothing that
  // matters.
  const { myTeamId } = await draftContext(id);
  const nextRun = nextWaiverRun(stored.rules, new Date());

  return (
    <div className="space-y-6">
      {chrome && <LeagueChrome {...chrome} active="/players" />}
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Players</h1>
        <p className="text-sm text-nocturne-neutral-500">
          Next waiver run {nextRun.toLocaleString()}. A claim is resolved by priority at the run
          its player clears at, which is not always the next one.
        </p>
      </header>

      {/*
        What the last run decided, above the market rather than below it.

        Somebody opening this page on a Wednesday is here *because* of the run —
        to find out whether they got the player. Putting the answer under the
        board would make them scroll past the thing they came for.

        Rendered whether or not they are signed in, and gated by
        `leagueReadForbidden` at the route: the resolution is a fact about the
        league, and anyone entitled to see the standings is entitled to see how a
        player changed hands. `myTeamId` only marks your own rows.
      */}
      <WaiverRunPanel leagueId={league.id} myTeamId={myTeamId} />

      {user ? (
        <PlayerMarket leagueId={league.id} />
      ) : (
        <section className="space-y-3 rounded border border-nocturne-neutral-900 p-6">
          <p className="text-sm text-nocturne-neutral-400">Sign in to add and drop players.</p>
          <a
            href={`/signin?next=${encodeURIComponent(`/leagues/${id}/players`)}`}
            className="inline-block rounded rounded-[4px] border border-nocturne-accent px-4 py-2 text-[13.5px] text-nocturne-accent-200 transition-colors hover:bg-nocturne-accent/10"
          >
            Sign in
          </a>
        </section>
      )}
    </div>
  );
}
