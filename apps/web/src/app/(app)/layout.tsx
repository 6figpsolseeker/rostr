import type { ReactNode } from "react";
import { SessionBar } from "@/components/SessionBar";
import { currentUser } from "@/lib/session";

/**
 * The signed-in application chrome.
 *
 * Split from the root layout when the marketing page arrived. The two want
 * genuinely different frames — the app is a fixed-width column under a utility
 * header, the landing page is full-bleed with its own sticky nav and a saturated
 * closing band that has to reach the viewport edges. Wrapping the landing page
 * in `max-w-4xl` would have quietly capped every section in it.
 *
 * A route group rather than a path segment, so no URL moves: `/leagues/…`,
 * `/scoring` and `/signin` are exactly where they were.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  // Resolved here rather than fetched by the header, so the first paint is
  // already right. A header that flashes "Sign in" before settling reads as if
  // you had been signed out.
  const user = await currentUser().catch(() => null);

  return (
    <>
      <header className="border-b border-white/10">
        <nav className="mx-auto flex max-w-4xl items-center justify-between px-6 py-4">
          <a href="/" className="text-lg font-semibold tracking-tight">
            rostr
          </a>
          <div className="flex items-center gap-5">
            <a href="/scoring" className="text-sm text-white/70 hover:text-white">
              How scoring works
            </a>
            <a
              href="/leagues/new"
              className="rounded bg-[--color-turf] px-3 py-1.5 text-sm font-medium text-black"
            >
              Create league
            </a>
            <SessionBar email={user?.email ?? null} />
          </div>
        </nav>
      </header>
      <main className="mx-auto max-w-4xl px-6 py-10">{children}</main>
      <footer className="mx-auto max-w-4xl px-6 py-10 text-xs text-white/40">
        Not audited. Do not use with funds you cannot lose.
      </footer>
    </>
  );
}
