import type { ReactNode } from "react";
import { HeroThrow } from "@/components/landing/HeroThrow";
import { HeaderControls } from "@/components/HeaderControls";
import { UrgentStrip } from "@/components/UrgentStrip";
import { SectionExplorer } from "@/components/landing/SectionExplorer";

/**
 * The marketing page.
 *
 * Nine bands on the Nocturne ground. Almost every word is lifted verbatim from
 * `README.md` — the four differentiators, the format table and the multi-sport
 * statement are the repo's own sentences rather than marketing rewrites of them,
 * so the page cannot drift from what the product claims. When the README's
 * wording changes, this should follow it.
 *
 * Three rules from the design system govern the whole page and are worth knowing
 * before editing it:
 *
 *   - The accent is a line, an edge and a glow, never a flood. There is exactly
 *     one saturated field on the page, the closing band.
 *   - Buttons are outlined, never filled.
 *   - Rules fade to transparent at both ends. That is why every divider is a
 *     gradient rather than a `border-top`.
 *
 * The page is a server component. The only client code is the hero animation,
 * which is imperative by necessity.
 */

const CONTAINER = "mx-auto w-full max-w-[1180px] px-10";

export default function LandingPage() {
  return (
    <div className="nocturne min-h-screen">
      <SiteHeader />
      <UrgentStrip />

      {/*
        Full-width text again — drop 7.

        Drop 6 put a condensed draft board beside the headline; drop 7 moves it
        into the section explorer below, where it gets the width a twelve-column
        board actually needs. The hero goes back to carrying one claim.
      */}
      <section className="mx-auto w-full max-w-[1180px] overflow-hidden">
        <HeroThrow
          headline={
            <>
              <Tag>Pre-alpha · 2026 NFL season</Tag>
              <h1 className="mt-6 text-[clamp(46px,6.2vw,86px)] font-medium leading-[1.02] tracking-[-0.035em]">
                Your roster
                <br />
                is yours.
              </h1>
            </>
          }
        >
          {/*
            The first sentence used to read "Drafted players are held in your wallet,
            not on a platform's server." That was never true — rosters are rows in
            Postgres — and it was the marketing half of the roster-as-NFT design that
            was abandoned on 2026-08-19.

            The headline above still stands, but it has to be earned by claims that
            hold. What makes a roster yours here is that nothing can reach into it:
            no override exists to call. That is checkable in the source, which the
            wallet claim never was.
          */}
          <p className="mt-8 max-w-[560px] text-[18.5px] leading-[1.62] text-nocturne-neutral-400">
            No commissioner can edit your team, force a trade through, or overrule a result —
            there is no such function to call. League rules are frozen at creation and hashed
            on-chain, and you sign that hash to join. The champion is derived from the Week 17
            result, not declared by an administrator.
          </p>

          <div className="mt-9 flex flex-wrap items-center gap-3">
            <PrimaryButton href="/leagues">Join or create a league</PrimaryButton>
            <GhostButton href="#how">See how a season runs</GhostButton>
          </div>

          <ul className="mt-9 flex flex-wrap gap-x-[22px] gap-y-2 text-[13px] text-nocturne-neutral-600">
            <li>Open source, MIT</li>
            <li>Full PPR, 12 teams</li>
            <li>Built for the Solana Seeker</li>
          </ul>
        </HeroThrow>
      </section>

      {/*
        Seven panels behind a rail, in one band — drop 7.

        `Differentiators`, `HowItWorks`, `Format` and `MultiSport` were four
        separate scrolling sections and are now four of the seven panels, with
        the draft board, a league week and the playoff bracket joining them. Their
        copy moved into `SectionExplorer` rather than being wrapped, because the
        design rewrote most of it — including demoting every heading a level now
        that the band owns the h2.
      */}
      <SectionExplorer />
      <ClosingBand />
      <SiteFooter />
    </div>
  );
}

/* ------------------------------------------------------------------ shared */

function Tag({ children, accent }: { children: ReactNode; accent?: boolean }) {
  return (
    <span
      className={`inline-block rounded-[4px] border px-2 py-1 text-[11px] uppercase tracking-[0.12em] ${
        accent
          ? "border-nocturne-accent/40 text-nocturne-accent-300"
          : "border-nocturne-neutral-800 text-nocturne-neutral-500"
      }`}
    >
      {children}
    </span>
  );
}

/** Outlined, never filled — the design system permits no solid buttons. */
function PrimaryButton({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      className="rounded-[4px] border border-nocturne-accent px-[22px] py-3 text-[14.5px] text-nocturne-accent-200 transition-colors hover:bg-nocturne-accent/10"
    >
      {children}
    </a>
  );
}

function GhostButton({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      className="rounded-[4px] border border-nocturne-neutral-800 px-[18px] py-3 text-[14.5px] text-nocturne-neutral-400 transition-colors hover:text-nocturne-text"
    >
      {children}
    </a>
  );
}

/* -------------------------------------------------------------------- 1 */

function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-nocturne-neutral-900 bg-[rgba(22,24,38,0.86)] backdrop-blur-[10px]">
      <nav className="mx-auto flex w-full max-w-[1180px] items-center justify-between px-10 py-[14px]">
        <a href="/" className="flex items-baseline gap-[10px]">
          <span className="text-[19px] font-semibold tracking-[-0.02em]">rostr</span>
          <span className="text-[11px] uppercase tracking-[0.14em] text-nocturne-neutral-600">
            fantasy football
          </span>
        </a>
        <div className="flex items-center gap-7">
          {/*
            One link, not three — drop 6, at the owner's request.

            `#how` lands on the first of three contiguous sections that answer one
            question between them: why it is different, how a season runs, and
            what the format is. Three tabs asked a reader to choose between three
            answers before knowing what any of them were, and the sections were
            already adjacent.

            The `#trust` and `#format` ids stay on their sections. Nothing points
            at them now, but they are what anyone who shared a deep link is
            holding, and breaking those to tidy a nav costs more than it saves.
          */}
          <a
            href="#how"
            className="text-[13.5px] text-nocturne-neutral-400 hover:text-nocturne-text"
          >
            How it works
          </a>
          <a
            href="https://github.com/6figpsolseeker/rostr"
            aria-label="rostr on GitHub"
            className="text-nocturne-neutral-500 transition-colors hover:text-nocturne-text"
          >
            <svg viewBox="0 0 16 16" aria-hidden className="h-[17px] w-[17px] fill-current">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
            </svg>
          </a>
          <a
            href="https://x.com/rostrfantasy"
            aria-label="rostr on X"
            className="text-nocturne-neutral-500 transition-colors hover:text-nocturne-text"
          >
            <svg viewBox="0 0 16 16" aria-hidden className="h-[15px] w-[15px] fill-current">
              <path d="M9.52 6.78 15.48 0h-1.41L8.89 5.89 4.76 0H0l6.25 8.9L0 16h1.41l5.46-6.22L11.24 16H16L9.52 6.78Zm-1.93 2.2-.63-.89L1.92 1.04h2.17l4.06 5.72.63.89 5.28 7.42h-2.17L7.59 8.98Z" />
            </svg>
          </a>
          {/*
            "Leagues", not "Create a league" — drop 9.

            Not everyone arriving is starting one; plenty are joining a friend's,
            and naming only the create path told half of them this was not for
            them. The /leagues hub is both doors.
          */}
          <a
            href="/leagues"
            className="rounded-[4px] border border-nocturne-accent px-4 py-2 text-[13px] text-nocturne-accent-200 transition-colors hover:bg-nocturne-accent/10"
          >
            Leagues
          </a>
          {/*
            **A link, not a wallet button, and that is a deliberate divergence.**

            The design draws this as a `<button>` because connecting is an
            action. Doing that here would mean mounting the wallet adapter on
            the marketing page to open a popup that can do nothing useful until
            there is an account behind it. `/welcome` is where connecting
            actually works — it verifies the wallet by signature, and is also
            where a username is claimed.

            **It also has to know whether you are already signed in.** It said
            `Connect wallet` unconditionally, so somebody who had just claimed a
            username and verified a wallet came back to this page and saw the
            same control as a stranger — which reads as "it forgot me". The
            wallet was connected throughout; nothing here said so.
          */}
          {/*
            Disconnected shows Connect wallet; connected replaces it in the
            same slot with the username and adds the bell to its left — drop
            9. It resolves the account itself, because this page is static.
          */}
          <HeaderControls />
        </div>
      </nav>
    </header>
  );
}

/* -------------------------------------------------------------------- 8 */

/** The page's one saturated field. Everything else is a line or an edge. */
function ClosingBand() {
  return (
    <section
      id="start"
      className="mx-5 mt-10 scroll-mt-[60px] rounded-[14px] px-12 py-[84px]"
      style={{
        background:
          "radial-gradient(120% 140% at 12% 0%, var(--color-nocturne-section-glow) 0%, var(--color-nocturne-section) 46%, #1d2048 100%)",
      }}
    >
      <div className="mx-auto grid w-full max-w-[1100px] gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.72fr)] lg:items-end">
        <div>
          <h2 className="text-[clamp(34px,4.4vw,54px)] font-medium leading-[1.06] tracking-[-0.03em]">
            A league can be joined, created, and drafted end to end today.
          </h2>
          <p className="mt-6 max-w-[520px] text-[16px] leading-[1.65] text-nocturne-accent-200">
            Nothing touches money yet. Bring eleven friends, or two — a single bot can square an
            odd field.
          </p>
          <div className="mt-9 flex flex-wrap items-center gap-3">
            <a
              href="/leagues"
              className="rounded-[4px] border border-nocturne-accent-300 px-[22px] py-3 text-[14.5px] text-nocturne-accent-100 transition-colors hover:bg-white/5"
            >
              Join or create a league
            </a>
            <a
              href="https://github.com/6figpsolseeker/rostr"
              className="rounded-[4px] border border-white/20 px-[18px] py-3 text-[14.5px] text-nocturne-accent-200 transition-colors hover:border-white/40"
            >
              Read the source
            </a>
          </div>
        </div>

        <div className="border-l border-[rgba(210,206,253,0.22)] pl-[22px] text-[13.5px] leading-[1.7] text-nocturne-accent-300">
          <p>Open source under MIT. Every rule this page describes is in the repository.</p>
          <p className="mt-4">
            Pre-alpha, targeting the 2026 season. The escrow program is not audited.
          </p>
        </div>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------- 9 */

function SiteFooter() {
  const links: readonly [string, string][] = [
    ["Rules", "docs/RULES.md"],
    ["Data model", "docs/DATA-MODEL.md"],
    ["Scoring", "docs/LIVE-SCORING.md"],
    ["Decisions", "docs/DECISIONS.md"],
  ];

  return (
    <footer className="mx-auto w-full max-w-[1180px] px-10 py-10">
      <div className="flex flex-wrap items-center justify-between gap-6 text-[13px] text-nocturne-neutral-600">
        <span className="text-[15px] font-semibold tracking-[-0.02em] text-nocturne-neutral-400">
          rostr
        </span>
        <div className="flex flex-wrap gap-6">
          {links.map(([label, path]) => (
            <a
              key={path}
              href={`https://github.com/6figpsolseeker/rostr/blob/main/${path}`}
              className="hover:text-nocturne-neutral-400"
            >
              {label}
            </a>
          ))}
        </div>
        <span>Pre-alpha. Not audited.</span>
      </div>
    </footer>
  );
}
