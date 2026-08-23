import type { ReactNode } from "react";
import Link from "next/link";
import { HeaderControls } from "@/components/HeaderControls";
import { UrgentStrip } from "@/components/UrgentStrip";
import { currentUser } from "@/lib/session";

/**
 * The signed-in application chrome, on the Nocturne ground.
 *
 * Converted from `field`/`chalk`/`turf` on 2026-08-16. This is the leverage
 * change in bringing the design handoff into the app: ten screens live under
 * this layout, and moving it moves the ground, the type and the header for all
 * of them at once. Each screen still needs its own pass — the tables, the cards
 * and the copy are per-screen — but none of them starts from the old palette.
 *
 * **The league nav is not here.** The design's header carries the league name,
 * its rules hash and six league-scoped links, and that belongs to the league
 * pages rather than to every signed-in screen: this layout also wraps `/scoring`
 * and `/signin`, which have no league. A `LeagueChrome` under `leagues/[id]`
 * is where that goes.
 *
 * The width is the design's 1180px rather than the old `max-w-4xl` (896px). The
 * screens under here are tables — a matchup, standings, a player market — and
 * they were being squeezed into two thirds of the space they were drawn for.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  // Resolved here rather than fetched by the header, so the first paint is
  // already right. A header that flashes "Sign in" before settling reads as if
  // you had been signed out.
  const user = await currentUser().catch(() => null);

  return (
    <div className="nocturne flex min-h-screen flex-col">
      <header className="border-b border-nocturne-neutral-900">
        <nav className="mx-auto flex w-full max-w-[1180px] items-center justify-between px-10 py-[14px]">
          <Link href="/" className="flex items-baseline gap-[10px]">
            <span className="text-[19px] font-semibold tracking-[-0.02em]">rostr</span>
            <span className="text-[11px] uppercase tracking-[0.14em] text-nocturne-neutral-600">
              fantasy football
            </span>
          </Link>

          <div className="flex items-center gap-6">
            <Link
              href="/scoring"
              className="text-[13.5px] text-nocturne-neutral-400 transition-colors hover:text-nocturne-text"
            >
              How scoring works
            </Link>
            {/*
              One `Leagues` item, not three — drop 8.

              The shell carried "Join a league", a "Create a league" button and
              the invitation badge side by side, and none of them led to the
              leagues you are already in. `/leagues` is now the hub — your
              leagues, your invitations, the public list — and create is a card
              in its head with equal weight rather than a button competing with
              the nav.

              **There is no badge, and this comment used to say there was.**
              The design keeps a count beside this link and calls it the one
              grounded element in its header; what shipped instead is the bell,
              which counts invitations among six kinds from a different route.
              Whether the badge returns is an open question — the bell already
              carries the number, and two counts that disagree for a second are
              worse than one.
            */}
            <a
              href="/leagues"
              className="text-[13.5px] text-nocturne-neutral-400 transition-colors hover:text-nocturne-text"
            >
              Leagues
            </a>
            {/*
              The bell and the account menu, replacing a bare username link, a
              sign-out button and an invitation count that sat inline. The
              count moves into the bell, which holds five other kinds besides.
            */}
            <HeaderControls username={user?.username ?? null} email={user?.email ?? null} />
          </div>
        </nav>
      </header>

      {/*
        Under the header, above everything. A 90-second clock cannot live behind
        a click — the bell holds the same item, so nothing lives only here.
      */}
      <UrgentStrip />

      <main className="mx-auto w-full max-w-[1180px] flex-1 px-10 py-12">{children}</main>

      <footer className="mx-auto w-full max-w-[1180px] px-10 py-8 text-[12.5px] text-nocturne-neutral-600">
        Pre-alpha. Not audited. Do not use with funds you cannot lose.
      </footer>
    </div>
  );
}
