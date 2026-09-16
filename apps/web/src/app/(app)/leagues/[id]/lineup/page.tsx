import { notFound } from "next/navigation";
import { lastPlayedWeek, NFL } from "@rostr/core";
import { getLeagueRules, transactionWeek } from "@rostr/db";
import { leagueReadAccess } from "@/lib/visibility";
import { chromeProps } from "@/lib/chrome";
import { LeagueChrome } from "@/components/LeagueChrome";
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

  // After the gate, never before: the chrome carries the league's name, size and
  // rules hash, which is exactly what a private league owes a stranger none of.
  const chrome = await chromeProps(id);

  const user = await currentUser();

  /*
    The week to show, and why it is not 1.

    It was: `Number.parseInt(week ?? "1")`, with no picker anywhere and the nav
    linking a bare `/lineup`. So from September onward every manager landed on
    week 1 — and a manager who wanted to set a playoff lineup had to know to type
    `?week=15` by hand. The autofill's late first pass (#288) was the same defect
    for abandoned teams; this is the half that belongs to people who are paying
    attention.

    The default is the week whose games come next — `transactionWeek`, read off
    `games`, the same week the autofill now prefills — so opening this page on a
    Wednesday offers the week about to be played rather than one from months ago.
    It falls back to 1 for a league whose season has no games ingested at all.
  */
  const stored = await getLeagueRules(db(), id);
  const upcoming = stored ? await transactionWeek(db(), stored.rules, new Date()) : null;
  const last = stored ? lastPlayedWeek(stored.rules.schedule) : NFL.seasonWeeks;
  const fallback = Math.min(upcoming ?? 1, last);

  const parsed = Number.parseInt(week ?? "", 10);
  const current = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, last) : fallback;

  return (
    <div className="space-y-6">
      {chrome && <LeagueChrome {...chrome} active="/lineup" />}
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Lineup</h1>
        {/*
          A plain week picker, so every week of the season is reachable without
          typing a query string. Links rather than a control: the page is
          server-rendered per week and nothing here needs state.
        */}
        <nav className="flex flex-wrap gap-1.5 text-[11px]" aria-label="Week">
          {Array.from({ length: last }, (_, index) => index + 1).map((number) => (
            <a
              key={number}
              href={`/leagues/${id}/lineup?week=${number}`}
              aria-current={number === current ? "page" : undefined}
              className={
                number === current
                  ? "rounded border border-nocturne-accent px-2 py-1 text-nocturne-accent-200"
                  : "rounded border border-nocturne-neutral-800 px-2 py-1 text-nocturne-neutral-400 hover:text-nocturne-text"
              }
            >
              {number}
            </a>
          ))}
        </nav>
      </header>

      {user ? (
        <LineupEditor leagueId={league.id} week={current} />
      ) : (
        <section className="space-y-3 rounded border border-nocturne-neutral-900 p-6">
          <p className="text-sm text-nocturne-neutral-400">Sign in to set your lineup.</p>
          <a
            href={`/signin?next=${encodeURIComponent(`/leagues/${id}/lineup`)}`}
            className="inline-block rounded rounded-[4px] border border-nocturne-accent px-4 py-2 text-[13.5px] text-nocturne-accent-200 transition-colors hover:bg-nocturne-accent/10"
          >
            Sign in
          </a>
        </section>
      )}
    </div>
  );
}
