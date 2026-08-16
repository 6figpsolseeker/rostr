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
}: {
  readonly leagueId: string;
  readonly name: string;
  /** "Week 3 · 12 teams · full PPR" — composed by the caller, which knows. */
  readonly subtitle: string;
  readonly rulesHash: string;
  /** The tab to mark current, as its `href` suffix. `""` is Home. */
  readonly active: (typeof TABS)[number]["href"];
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
    </div>
  );
}
