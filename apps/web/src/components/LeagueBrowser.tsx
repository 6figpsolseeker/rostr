"use client";

import useSWR from "swr";

/**
 * Public leagues you could join.
 *
 * The screen behind **Join a league**. Every league here is PUBLIC and still
 * FORMING — private leagues are reached by invitation or by their link and must
 * never appear in a directory, and a league past its draft time cannot take
 * anyone at all, because migration `0028` locks the field at that instant.
 *
 * **It does not join anything.** Every card links to the league page, where the
 * full rule set is rendered above the join control. `RULES.md` requires the
 * whole document to be shown before anyone joins, and a "join" button in a
 * directory would be a way to agree to a rule set nobody had read — which is the
 * one thing this product exists not to do.
 */

interface OpenLeague {
  id: string;
  name: string;
  season: number;
  teamCount: number;
  maxTeams: number | null;
  /** Unix seconds, rendered against the reader's own clock. */
  scheduledAt: number | null;
  /** Base units as a decimal string, or null for a free league. */
  buyIn: string | null;
}

const fetcher = async (url: string): Promise<OpenLeague[]> => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load leagues (${response.status})`);
  return response.json() as Promise<OpenLeague[]>;
};

/**
 * A buy-in, in whole tokens.
 *
 * Base units divided by 10^6 — `POT_MINT_DECIMALS`, which the program requires
 * of every pot mint precisely so this arithmetic means dollars. Done as string
 * surgery rather than division: invariant 2 says no floating point anywhere near
 * money, and `Number("50000000") / 1e6` is exactly the shape that rule forbids.
 */
function buyInText(baseUnits: string | null): string {
  if (baseUnits === null) return "Free";

  const digits = baseUnits.replace(/^0+(?=\d)/, "").padStart(7, "0");
  const whole = digits.slice(0, -6);
  const fraction = digits.slice(-6).replace(/0+$/, "");
  return fraction === "" ? `$${whole}` : `$${whole}.${fraction}`;
}

/** "Sat 22 Aug, 20:00" in the reader's timezone, or a dash. */
function draftText(scheduledAt: number | null): string {
  if (scheduledAt === null) return "—";
  return new Date(scheduledAt * 1000).toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function LeagueBrowser() {
  const { data, error } = useSWR<OpenLeague[]>("/api/leagues", fetcher, {
    revalidateOnFocus: true,
  });

  if (error) return <p className="text-sm text-red-400">{error.message}</p>;
  if (!data) return <p className="text-sm text-nocturne-neutral-600">Looking for leagues…</p>;

  if (data.length === 0) {
    return (
      <div className="space-y-3 rounded-lg border border-nocturne-neutral-900 p-6">
        <p className="text-sm text-nocturne-neutral-400">
          No public leagues are open right now.
        </p>
        <p className="text-sm text-nocturne-neutral-600">
          Leagues are private by default, so most are joined by invitation. If somebody asked
          you to one, it will be waiting under Invitations.
        </p>
        <a
          href="/leagues/new"
          className="inline-block rounded-[4px] border border-nocturne-accent px-4 py-2 text-[13.5px] text-nocturne-accent-200 transition-colors hover:bg-nocturne-accent/10"
        >
          Create one instead
        </a>
      </div>
    );
  }

  return (
    <ul className="grid gap-3 sm:grid-cols-2">
      {data.map((league) => {
        // `maxTeams` is the signed rule, so a league with no rules row — which
        // should not exist — shows seats rather than a confident wrong total.
        const full = league.maxTeams !== null && league.teamCount >= league.maxTeams;

        return (
          <li key={league.id}>
            <a
              href={`/leagues/${league.id}`}
              className="block h-full space-y-3 rounded-lg border border-nocturne-neutral-900 p-5 transition-colors hover:border-nocturne-neutral-800 hover:bg-nocturne-surface/30"
            >
              <div className="flex items-baseline justify-between gap-3">
                <h2 className="truncate text-base font-medium">{league.name}</h2>
                <span className="shrink-0 text-xs text-nocturne-neutral-500">
                  {buyInText(league.buyIn)}
                </span>
              </div>

              <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
                <div>
                  <dt className="text-nocturne-neutral-600">Seats</dt>
                  <dd className={full ? "text-amber-400" : ""}>
                    {league.teamCount}
                    {league.maxTeams !== null && ` of ${league.maxTeams}`}
                    {full && " · full"}
                  </dd>
                </div>
                <div>
                  <dt className="text-nocturne-neutral-600">Draft</dt>
                  <dd>{draftText(league.scheduledAt)}</dd>
                </div>
              </dl>

              <p className="text-xs text-nocturne-neutral-600">
                {/*
                  Says what the next screen does. The rules are shown in full
                  before the join control, always — so this link is "read it",
                  not "join it", and the copy should not promise otherwise.
                */}
                Read the rules and join &rarr;
              </p>
            </a>
          </li>
        );
      })}
    </ul>
  );
}
