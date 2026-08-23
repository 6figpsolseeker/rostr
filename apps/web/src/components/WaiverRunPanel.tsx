"use client";

import useSWR from "swr";
import { runSummary, whyClaimFailed } from "@/lib/waiver-run";

/**
 * What the last waiver run decided, and why.
 *
 * `processWaivers` runs hourly, resolves every claim by the frozen rules, moves
 * priority and rewrites rosters — and **told nobody**. A manager filed claims on
 * Monday and on Wednesday found a player on their roster, or did not, with no
 * account of which claim won, which lost, or why.
 *
 * That is a strange gap for this product in particular. The argument the whole
 * thing makes is that outcomes are decided by rules anybody can check rather
 * than by an administrator; a resolution nobody can watch being carried out is
 * indistinguishable from one somebody made up.
 *
 * **Every team's claims, not just yours.** "A team with better priority claimed
 * him first" is an unverifiable assertion if the only row you can see is your
 * own — the claim it makes is precisely about somebody else.
 */

interface Claim {
  claimId: string;
  teamId: string;
  teamName: string;
  addPlayerName: string;
  dropPlayerName: string | null;
  priorityAtClaim: number | null;
  awarded: boolean;
  failureReason: string | null;
}

interface Run {
  processedAt: string;
  claims: Claim[];
}

const fetcher = async (url: string): Promise<Run | null> => {
  const response = await fetch(url);
  if (!response.ok) return null;
  const body = (await response.json()) as { run?: Run | null };
  return body.run ?? null;
};

export function WaiverRunPanel({
  leagueId,
  myTeamId,
}: {
  readonly leagueId: string;
  /** Used only to mark your own rows. The panel shows the whole run regardless. */
  readonly myTeamId: string | null;
}) {
  const { data: run } = useSWR<Run | null>(`/api/leagues/${leagueId}/waiver-run`, fetcher, {
    revalidateOnFocus: true,
  });

  // Nothing has run yet. Rendering "no waiver runs" every week until the first
  // Wednesday of the season would be furniture — the same argument the
  // invitations corner makes for disappearing when empty.
  if (!run || run.claims.length === 0) return null;

  const awarded = run.claims.filter((claim) => claim.awarded).length;

  return (
    <section className="space-y-3 rounded-lg border border-nocturne-neutral-900 p-5">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium tracking-wide text-nocturne-neutral-500 uppercase">
          Last waiver run
        </h2>
        <span className="text-xs text-nocturne-neutral-600">
          {runSummary({ total: run.claims.length, awarded })} ·{" "}
          {new Date(run.processedAt).toLocaleString()}
        </span>
      </header>

      <ul className="space-y-2">
        {run.claims.map((claim) => {
          const mine = claim.teamId === myTeamId;

          return (
            <li
              key={claim.claimId}
              className={`rounded border px-3 py-2 text-sm ${
                mine
                  ? "border-nocturne-accent/40 bg-nocturne-accent/5"
                  : "border-nocturne-neutral-900"
              }`}
            >
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                {/*
                  Priority is shown on every row, won or lost. It is the number
                  the rules actually decide on, so a run that hides it asks
                  people to take the ordering on trust — which is the thing this
                  product exists not to ask.
                */}
                {claim.priorityAtClaim !== null && (
                  <span className="text-[11px] tabular-nums text-nocturne-neutral-600">
                    #{claim.priorityAtClaim}
                  </span>
                )}
                <span className="text-nocturne-neutral-400">
                  {mine ? "You" : claim.teamName}
                </span>
                <span className="text-nocturne-text">{claim.addPlayerName}</span>
                {claim.dropPlayerName && (
                  <span className="text-[11px] text-nocturne-neutral-600">
                    dropping {claim.dropPlayerName}
                  </span>
                )}
                <span
                  className={`ml-auto text-[11px] ${
                    claim.awarded ? "text-nocturne-accent-300" : "text-nocturne-neutral-600"
                  }`}
                >
                  {claim.awarded ? "awarded" : "not awarded"}
                </span>
              </div>

              {/*
                The reason, on losing rows only — a winner has nothing to
                explain, and `0039`'s constraint means there is never one stored.
              */}
              {!claim.awarded && (
                <p className="mt-1 text-[11px] text-nocturne-neutral-600">
                  {whyClaimFailed(claim.failureReason)}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
