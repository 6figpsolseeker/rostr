import type { ReactNode } from "react";
import Link from "next/link";
import { InvitationBadge } from "@/components/InvitationsCorner";
import { SessionBar } from "@/components/SessionBar";
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
              Joining and creating sit side by side, and joining is first.
              Creating a league has had a front door since A10; joining one has
              never had anywhere to start, so a league was reachable only by
              holding its URL. Most people arrive wanting to be in a league
              rather than to run one.
            */}
            <span className="flex items-center gap-2">
              <Link
                href="/leagues"
                className="text-[13.5px] text-nocturne-neutral-400 transition-colors hover:text-nocturne-text"
              >
                Join a league
              </Link>
              {/*
                Rendered only when something is waiting, and only for a signed-in
                visitor — the route answers an empty list to anyone else, so a
                logged-out header makes one cheap request and draws nothing.
              */}
              {user && <InvitationBadge />}
            </span>
            <Link
              href="/leagues/new"
              className="rounded-[4px] border border-nocturne-accent px-4 py-2 text-[13px] text-nocturne-accent-200 transition-colors hover:bg-nocturne-accent/10"
            >
              Create a league
            </Link>
            <SessionBar email={user?.email ?? null} username={user?.username ?? null} />
          </div>
        </nav>
      </header>

      <main className="mx-auto w-full max-w-[1180px] flex-1 px-10 py-12">{children}</main>

      <footer className="mx-auto w-full max-w-[1180px] px-10 py-8 text-[12.5px] text-nocturne-neutral-600">
        Pre-alpha. Not audited. Do not use with funds you cannot lose.
      </footer>
    </div>
  );
}
