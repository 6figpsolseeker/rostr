"use client";

import useSWR from "swr";

/**
 * The leagues you are already in.
 *
 * The gap drop 8 named: `/leagues` browsed *public* leagues, which are by
 * definition the ones you are not in, so a returning manager's only route back
 * to their own league was browser history.
 *
 * ## What each row says, and what it does not
 *
 * One line per league, and the line is chosen by state — seats and a draft time
 * while forming, the round while drafting, the week once playing. The design
 * also draws a record, a standings position and whether your lineup is set;
 * those cost a standings computation or a kickoff lookup per league on a page
 * that renders every visit, so they are left to the screens that own them
 * rather than approximated here.
 *
 * **`onTheClock` is the one urgent fact with a real source.** The design's
 * urgent strip also wants a closing veto window, an unset lineup near kickoff
 * and a waiver run; none of those has a route today. Drawing them would be
 * inventing state on a page whose whole job is to tell you what is true.
 */

interface MyLeague {
  id: string;
  name: string;
  state: string;
  teamCount: number;
  teamName: string;
  draftScheduledAt: number | null;
  draftStatus: string | null;
  rounds: number | null;
  currentRound: number | null;
  onTheClock: boolean;
}

const fetcher = async (url: string): Promise<MyLeague[]> => {
  const response = await fetch(url);
  if (!response.ok) return [];
  const body = (await response.json()) as { leagues?: MyLeague[] };
  return body.leagues ?? [];
};

/** "Sat 23 Aug, 20:00" in the reader's own timezone. */
function when(seconds: number | null): string {
  if (seconds === null) return "not scheduled";
  return new Date(seconds * 1000).toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * The one line worth showing for a league in this state.
 *
 * Written as a switch over the state machine rather than a pile of conditionals
 * so an unhandled state renders something honest instead of an empty row —
 * `SETTLED` and `DISSOLVED` are real states this hub will meet.
 */
function status(league: MyLeague): string {
  switch (league.state) {
    case "FORMING":
      return `${league.teamCount} in · drafts ${when(league.draftScheduledAt)}`;
    case "DRAFTING":
      return league.currentRound !== null && league.rounds !== null
        ? `Drafting · round ${league.currentRound} of ${league.rounds}`
        : `Drafting · starts ${when(league.draftScheduledAt)}`;
    case "IN_SEASON":
      return `In season · ${league.teamCount} teams`;
    case "PLAYOFFS":
      return `Playoffs · ${league.teamCount} teams`;
    case "SETTLED":
      return "Settled";
    case "DISSOLVED":
      return "Dissolved";
    default:
      return league.state;
  }
}

export function YourLeagues() {
  const { data, isLoading } = useSWR<MyLeague[]>("/api/me/leagues", fetcher, {
    revalidateOnFocus: true,
  });

  const leagues = data ?? [];

  // Nothing at all while loading and nothing when empty — the hub's other two
  // sections say what to do next, and an empty "you have no leagues" card above
  // a list of leagues you could join would be saying it twice.
  if (isLoading || leagues.length === 0) return null;

  return (
    <section className="space-y-3">
      <header className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium tracking-wide text-nocturne-neutral-500 uppercase">
          Your leagues
        </h2>
        <span className="text-xs text-nocturne-neutral-600">
          {leagues.length} {leagues.length === 1 ? "league" : "leagues"}
        </span>
      </header>

      <ul className="grid gap-3 sm:grid-cols-2">
        {leagues.map((league) => (
          <li key={league.id}>
            <a
              href={league.onTheClock ? `/leagues/${league.id}/draft` : `/leagues/${league.id}`}
              className={`block h-full space-y-2 rounded-lg border p-5 transition-colors ${
                league.onTheClock
                  ? "border-nocturne-accent bg-nocturne-accent/5"
                  : "border-nocturne-neutral-900 hover:border-nocturne-neutral-800 hover:bg-nocturne-surface/30"
              }`}
            >
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="truncate text-base font-medium">{league.name}</h3>
                <span className="shrink-0 text-xs text-nocturne-neutral-600">
                  {league.teamName}
                </span>
              </div>

              <p className="text-xs text-nocturne-neutral-500">{status(league)}</p>

              {league.onTheClock && (
                // The only urgent state with a real source. A 90-second clock
                // cannot live behind a click, so it is on the card and the card
                // links straight into the draft rather than the league page.
                <p className="text-sm font-medium text-nocturne-accent-200">
                  You are on the clock &rarr;
                </p>
              )}
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
