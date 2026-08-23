/**
 * The header every league-scoped screen wears.
 *
 * The design puts four things here and each is load-bearing rather than
 * decoration:
 *
 *   - the league's **name**, because a manager is usually in more than one
 *   - the week, size and format, so the screen says which season it is showing
 *   - the **rules hash**, which is the whole promise of the product sitting in
 *     the chrome rather than buried on a settings page
 *   - the nav, because these six screens are the product
 *
 * Deliberately not in `(app)/layout.tsx`. That layout also wraps `/scoring` and
 * `/signin`, which have no league — a nav there would either render empty or
 * force every page to supply a league it does not have.
 *
 * A server component with no state: everything it shows is already loaded by
 * the page rendering it, and re-fetching here would be a second query per
 * screen for facts the caller has in hand.
 */

const TABS = [
  { href: "", label: "Home" },
  { href: "/matchup", label: "Matchup" },
  { href: "/lineup", label: "My team" },
  { href: "/players", label: "Players" },
  { href: "/trades", label: "Trades" },
  { href: "/standings", label: "Standings" },
] as const;

export function LeagueChrome({
  leagueId,
  name,
  subtitle,
  rulesHash,
  active,
  navOpen,
}: {
  readonly leagueId: string;
  readonly name: string;
  /** "Week 3 · 12 teams · full PPR" — composed by the caller, which knows. */
  readonly subtitle: string;
  readonly rulesHash: string;
  /**
   * The tab to mark current, as its `href` suffix. `""` is Home.
   *
   * `"NONE"` for a screen the nav does not contain — the bracket and the draft
   * room, which are deliberately not tabs. Borrowing a neighbouring tab was the
   * obvious alternative and is wrong: the marker sets `aria-current="page"`, so
   * it would tell a screen reader the visitor is on Standings while they are on
   * the bracket. A screen with no tab should light no tab.
   */
  readonly active: (typeof TABS)[number]["href"] | "NONE";
  /**
   * Whether these tabs lead anywhere for this viewer — `leagueNavOpen`.
   *
   * Five of the six 404 for a non-member, because the league is private and
   * `leagueReadAccess` refuses. That refusal is correct and must stay: a "this
   * league is private" page would confirm the league exists to anyone holding
   * the URL. What was wrong was offering the doors.
   *
   * The commissioner is the person most likely to meet this. Creating a league
   * seats nobody — see #165 — so they land on their own league with six tabs
   * and no team, and every one of them fails.
   *
   * **Required rather than optional-defaulting-to-true.** `CLAUDE.md`: "an
   * optional filter defaulting to 'all' is not a filter." A default would let
   * the next caller inherit the bug by saying nothing.
   */
  readonly navOpen: boolean;
}) {
  return (
    <div className="mb-10 border-b border-nocturne-neutral-900 pb-0">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-[30px] font-medium leading-[1.1] tracking-[-0.028em]">{name}</h1>
          <p className="mt-2 text-[13.5px] text-nocturne-neutral-500">{subtitle}</p>
        </div>

        {/*
          Truncated, and a `title` carries the whole thing. The full 64
          characters would dominate the header, and the point of showing it is
          that it exists and can be checked — not that anyone reads it here.
        */}
        <span
          title={rulesHash}
          className="rounded-[4px] border border-nocturne-neutral-800 px-2 py-1 font-mono text-[11.5px] text-nocturne-neutral-600"
        >
          {rulesHash.slice(0, 6)}…{rulesHash.slice(-4)}
        </span>
      </div>

      {/*
        Hidden, not greyed out.

        A disabled tab is a promise about a future that may never arrive — for a
        stranger who will never join, "Standings, once you join" is simply
        false. And this codebase already decided the general case: the draft and
        bracket are not tabs because a dead link for most of a season would be
        one, and `CLAUDE.md` says a greyed-out Week 16 fixture "would be an
        invention". Five greyed labels would also compete for attention with the
        one control that does work, which is the join panel below.
      */}
      {!navOpen ? null : (
        <nav className="mt-7 flex flex-wrap gap-7">
          {TABS.map((tab) => {
            const current = tab.href === active;
            return (
              <a
                key={tab.label}
                href={`/leagues/${leagueId}${tab.href}`}
                aria-current={current ? "page" : undefined}
                className={`-mb-px border-b-2 pb-3 text-[14px] transition-colors ${
                  current
                    ? "border-nocturne-accent text-nocturne-text"
                    : "border-transparent text-nocturne-neutral-500 hover:text-nocturne-text"
                }`}
              >
                {tab.label}
              </a>
            );
          })}
        </nav>
      )}
    </div>
  );
}
