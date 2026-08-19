import type { ReactNode } from "react";
import { HeroThrow } from "@/components/landing/HeroThrow";
import { LandingAccountLink } from "@/components/landing/LandingAccountLink";
import { LandingDraftBoard } from "@/components/landing/LandingDraftBoard";

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

      {/*
        Two columns: the claim, and a draft mid-round.

        The board is illustrative and says so — see `LandingDraftBoard`. It sits
        beside the headline rather than below it because the product's argument
        is visual: a snake board with a block-drawn order is the thing no other
        platform can show.

        `overflow-hidden` stays on the section. `HeroThrow` animates a ball
        across its own box and the board crops twelve columns to three; both
        would otherwise widen the page on a narrow viewport.
      */}
      <section className="mx-auto grid w-full max-w-[1180px] gap-8 overflow-hidden lg:grid-cols-[minmax(0,1fr)_26rem]">
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
            <PrimaryButton href="/leagues/new">Create a free league</PrimaryButton>
            <GhostButton href="#how">See how a season runs</GhostButton>
          </div>

          <ul className="mt-9 flex flex-wrap gap-x-[22px] gap-y-2 text-[13px] text-nocturne-neutral-600">
            <li>Open source, MIT</li>
            <li>Full PPR, 12 teams</li>
            <li>Built for the Solana Seeker</li>
          </ul>
        </HeroThrow>

        <div className="px-10 pt-24 lg:pl-0">
          <LandingDraftBoard />
        </div>
      </section>

      <LeaguePanel />
      <Differentiators />
      <HowItWorks />
      <Format />
      <MultiSport />
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

function Kicker({ children }: { children: ReactNode }) {
  return (
    <p className="text-[11px] uppercase tracking-[0.14em] text-nocturne-accent-500">
      {children}
    </p>
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
          <a
            href="/leagues/new"
            className="rounded-[4px] border border-nocturne-accent px-4 py-2 text-[13px] text-nocturne-accent-200 transition-colors hover:bg-nocturne-accent/10"
          >
            Create a league
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
          <LandingAccountLink />
        </div>
      </nav>
    </header>
  );
}

/* -------------------------------------------------------------------- 3 */

/**
 * A league's week, as it actually reads.
 *
 * The numbers are illustrative and the players invented. This wants real data
 * once the stats pipeline has a producer — `stat_lines` is empty today, so there
 * is nothing truthful to render here yet.
 */
function LeaguePanel() {
  const lineup: readonly [string, string, string, string, boolean][] = [
    ["QB", "J. Barrow", "18.4", "21.2", false],
    ["RB", "A. Villanueva", "14.1", "16.8", false],
    ["RB", "D. Okonkwo", "11.7", "9.3", false],
    ["WR", "T. Mackey", "13.2", "17.5", false],
    ["FLEX", "R. Silva", "10.9", "—", true],
  ];

  return (
    <section className={`${CONTAINER} py-[84px]`}>
      <div className="grid gap-14 lg:grid-cols-[minmax(0,0.72fr)_minmax(0,1fr)] lg:items-start">
        <div>
          <Kicker>Inside a league</Kicker>
          <h2 className="mt-4 text-[34px] font-medium leading-[1.14] tracking-[-0.025em]">
            The week you already know how to read.
          </h2>
          <p className="mt-5 max-w-[440px] text-[16px] leading-[1.65] text-nocturne-neutral-400">
            Head-to-head matchups, a waiver wire, a trade deadline, a playoff bracket. The
            format is the one every manager already has in muscle memory — what changes is who
            can alter it afterwards.
          </p>
          <ul className="mt-7 space-y-3 text-[15px] text-nocturne-neutral-400">
            {[
              "Weeks 1–14 head-to-head, 15–17 playoffs",
              "Rolling waiver priority — win a claim, go to the back",
              "Consolation bracket is played, so nobody is left with nothing",
            ].map((line) => (
              <li key={line} className="flex gap-3">
                <span className="text-nocturne-accent-500">&mdash;</span>
                <span>{line}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="overflow-hidden rounded-lg bg-nocturne-surface shadow-[0_0_0_1px_#595d6c,0_6px_18px_rgba(0,0,0,0.55)]">
          <div className="flex items-center justify-between border-b border-nocturne-neutral-900 px-[18px] py-[14px]">
            <span className="text-[14.5px] font-medium">Route 66</span>
            <div className="flex items-center gap-3">
              <span className="text-[11.5px] text-nocturne-neutral-600">Week 3</span>
              <Tag accent>Rules locked</Tag>
            </div>
          </div>

          <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-4 border-b border-nocturne-neutral-900 px-[18px] py-5">
            <div>
              <p className="text-[14px]">Route 66</p>
              <p className="text-[11.5px] text-nocturne-neutral-600">2-0 · proj 118.4</p>
            </div>
            <div className="flex items-center gap-3 tabular-nums">
              <span className="text-[27px] text-nocturne-accent-300">68.4</span>
              <span className="text-[12px] text-nocturne-neutral-600">vs</span>
              <span className="text-[27px] text-nocturne-neutral-400">61.9</span>
            </div>
            <div className="text-right">
              <p className="text-[14px]">Fourth &amp; Long</p>
              <p className="text-[11.5px] text-nocturne-neutral-600">1-1 · proj 112.0</p>
            </div>
          </div>

          <table className="w-full border-b border-nocturne-neutral-900 text-[13px]">
            <thead>
              <tr className="text-nocturne-neutral-600">
                <th className="px-[18px] py-2 text-left font-normal">Slot</th>
                <th className="py-2 text-left font-normal">Starter</th>
                <th className="py-2 text-right font-normal">Proj</th>
                <th className="px-[18px] py-2 text-right font-normal">Pts</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {lineup.map(([slot, player, proj, pts, flex]) => (
                <tr key={`${slot}-${player}`} className="border-t border-nocturne-neutral-900">
                  <td className="px-[18px] py-[9px]">
                    <span
                      className={`rounded-[4px] border px-[7px] py-[2px] text-[10px] ${
                        flex
                          ? "border-nocturne-accent/40 text-nocturne-accent-300"
                          : "border-nocturne-neutral-800 text-nocturne-neutral-500"
                      }`}
                    >
                      {slot}
                    </span>
                  </td>
                  <td className="py-[9px]">{player}</td>
                  <td className="py-[9px] text-right text-nocturne-neutral-400">{proj}</td>
                  <td className="px-[18px] py-[9px] text-right">{pts}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="flex items-center justify-between px-[18px] py-[13px] text-[11.5px] text-nocturne-neutral-600">
            <span>Autolineup on · waiver priority 7 of 12</span>
            <span className="font-mono">0x7f3a…c19d</span>
          </div>
        </div>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------- 4 */

function Differentiators() {
  return (
    <section id="how" className={`${CONTAINER} scroll-mt-[60px] py-[84px]`}>
      {/* Kept because deep links already point here. */}
      <span id="trust" className="block scroll-mt-[60px]" />
      <div className="max-w-[640px]">
        <Kicker>Why it&rsquo;s different</Kicker>
        <h2 className="mt-4 text-[40px] font-medium leading-[1.1] tracking-[-0.028em]">
          Every other platform asks you to trust an administrator.
        </h2>
        <p className="mt-5 text-[16px] leading-[1.65] text-nocturne-neutral-400">
          This one doesn&rsquo;t. Four things are true of a rostr league that are not true
          anywhere else.
        </p>
      </div>

      <div className="mt-12 grid gap-5 sm:grid-cols-2">
        <Card
          index="01"
          title="Rules are immutable"
          closing="No commissioner can rewrite scoring in Week 10 because their team is losing."
          closingAccent
        >
          A league&rsquo;s scoring, roster, payout split, and deadlines are frozen at creation
          and shown in full before anyone joins. The rule set is hashed on-chain and joining is
          a signed transaction referencing that hash — so consent is cryptographic, not a
          checkbox.
        </Card>

        {/*
          The escrow is built, tested and deployed — join, stake, settle and the
          unconditional timelock refund all work against a real validator. What
          is not happening is the 2026 season running on it, which is a decision
          rather than a gap, so this card describes it in the future tense and
          says so plainly rather than quietly dropping the claim.

          Do not restore the present tense here without also opening
          `POT_LEAGUES_OPEN`. A landing page promising an escrowed pot above a
          create form that offers only free leagues is the site contradicting
          itself on the one subject where trust is the product.
        */}
        <Card
          index="02"
          title="The pot is escrowed"
          closing="Coming soon. Every league this season is free to play, and everything else on this page is live today."
        >
          Built and tested: everyone deposits the same amount of the same token, funds sit in a
          vault no person holds the keys to, and an unconditional refund opens if a season never
          settles. Pot leagues are not part of the 2026 season.
        </Card>

        <Card index="03" title="Nobody declares a winner">
          The contract holds the bracket, the scores, and the rules, and derives the champion
          from the Week 17 result. There is no sign-off step to corrupt.
        </Card>

        {/*
          This claimed drafted players mint as Token-2022 NFTs held in your wallet.
          Nothing has ever minted one — there is no NFT program, and as of
          2026-08-19 the roster-as-NFT design is abandoned rather than pending:
          the enforcement it needed (transfer hook, permanent delegate) existed
          only to stop a roster being sold out from under a league, and that is a
          problem the database already solves.

          What is left here is the half that was true all along and is shipped:
          the trade escrow, the veto window, and the absence of any commissioner
          override. Do not restore an NFT sentence to this card until something
          actually mints.
        */}
        <Card index="04" title="Your roster is yours">
          A trade freezes both sides the moment it is accepted, then waits out a 48-hour window
          in which a third of the uninvolved managers can veto it. No commissioner can force one
          through, reverse one, or edit a roster — there is no such function to call.
        </Card>
      </div>
    </section>
  );
}

function Card({
  index,
  title,
  children,
  closing,
  closingAccent,
}: {
  index: string;
  title: string;
  children: ReactNode;
  closing?: string;
  closingAccent?: boolean;
}) {
  return (
    <div className="rounded-lg bg-nocturne-surface p-[26px] shadow-[0_0_0_1px_#292b31]">
      <p className="font-mono text-[11.5px] text-nocturne-accent-600">{index}</p>
      <h3 className="mt-4 text-[21px] font-medium tracking-[-0.018em]">{title}</h3>
      <p className="mt-3 text-[14.5px] leading-[1.6] text-nocturne-neutral-400">{children}</p>
      {closing ? (
        <p
          className={`mt-4 text-[14.5px] leading-[1.6] ${
            closingAccent ? "text-nocturne-accent-300" : "text-nocturne-neutral-600"
          }`}
        >
          {closing}
        </p>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------- 5 */

function HowItWorks() {
  const steps: readonly [string, string][] = [
    [
      "Create and freeze",
      "Pick a format or take the default. The rule set is hashed and written on-chain before anyone joins.",
    ],
    [
      "Draw the order",
      "The draft order comes from a Solana block produced after the field locks — nobody can grind it, and anyone can recompute it.",
    ],
    [
      "Draft and play",
      "A snake draft, then head-to-head weeks. Each pick is a signed transaction against the frozen rules.",
    ],
    [
      "Settle",
      "The champion derives from the Week 17 result. Nothing is signed off, because there is nothing to sign off.",
    ],
  ];

  return (
    <section id="how-steps" className={`${CONTAINER} scroll-mt-[60px] py-[84px]`}>
      <div className="max-w-[640px]">
        <Kicker>How it works</Kicker>
        <h2 className="mt-4 text-[40px] font-medium leading-[1.1] tracking-[-0.028em]">
          A season, end to end.
        </h2>
      </div>

      {/*
        Fixed 4-up rather than `auto-fit`, which orphans step 4 onto its own row
        at intermediate widths. 2×2 below the large breakpoint, 1-up on small.
      */}
      <ol className="mt-12 grid gap-[30px] sm:grid-cols-2 lg:grid-cols-4">
        {steps.map(([title, body], i) => (
          <li key={title}>
            <div className="h-px w-full bg-gradient-to-r from-nocturne-accent to-nocturne-accent-800" />
            <p className="mt-4 font-mono text-[11.5px] text-nocturne-neutral-500">
              Step {i + 1}
            </p>
            <h3 className="mt-3 text-[19px] font-medium">{title}</h3>
            <p className="mt-3 text-[14.5px] leading-[1.6] text-nocturne-neutral-400">{body}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

/* -------------------------------------------------------------------- 6 */

function Format() {
  const rows: readonly [string, ReactNode][] = [
    [
      "Scoring",
      "Full PPR. 4pt passing TD, 6pt rushing/receiving TD, 1pt per 25 passing yards, 1pt per 10 rushing/receiving yards, −2 per interception and lost fumble.",
    ],
    ["Teams", "12 teams, minimum 2 humans, bots fill the rest."],
    ["Draft", "Snake draft, fast (90s minimum) or slow (up to 24h per pick)."],
    [
      "Season",
      "Weeks 1–14 regular season, 15–17 playoffs, championship Week 17. Week 18 is excluded — NFL starters rest once seeding is settled.",
    ],
    ["Matchups", "Head-to-head weekly. Schedule luck is retained deliberately."],
    ["Waivers", "Rolling priority. Win a claim, go to the back of the order."],
    [
      "Consolation",
      "The consolation bracket is played, so eliminated teams still have something to play for. This is the anti-abandonment mechanism — punishment doesn't work on someone already guaranteed nothing.",
    ],
  ];

  return (
    <section id="format" className={`${CONTAINER} scroll-mt-[60px] py-[84px]`}>
      <div className="grid gap-14 lg:grid-cols-[minmax(0,0.6fr)_minmax(0,1fr)]">
        <div>
          <Kicker>Format</Kicker>
          <h2 className="mt-4 text-[34px] font-medium leading-[1.14] tracking-[-0.025em]">
            The default league, in full.
          </h2>
          <p className="mt-5 text-[15px] leading-[1.65] text-nocturne-neutral-400">
            Every value below is frozen when a league is created. The complete rule set lives in{" "}
            <a
              href="https://github.com/6figpsolseeker/rostr/blob/main/docs/RULES.md"
              className="text-nocturne-accent-300 underline underline-offset-4"
            >
              docs/RULES.md
            </a>
            .
          </p>
        </div>

        <table className="w-full text-[14.5px]">
          <tbody>
            {rows.map(([label, value]) => (
              <tr key={label} className="border-t border-nocturne-neutral-900 first:border-t-0">
                <th className="w-[150px] py-4 pr-6 text-left align-top font-normal text-nocturne-neutral-500">
                  {label}
                </th>
                <td className="py-4 align-top leading-[1.6] text-nocturne-neutral-400">
                  {value}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------- 7 */

function MultiSport() {
  return (
    <section className={`${CONTAINER} py-[84px]`}>
      <Kicker>Multi-sport</Kicker>
      <p className="mt-6 max-w-[860px] text-[clamp(24px,3.1vw,36px)] font-medium leading-[1.26] tracking-[-0.024em]">
        Football ships first, but the schema does not know what football is. Sports are data — a
        registry of stat keys, positions, and lineup slots — never structure or code branches.
      </p>
      <p className="mt-6 max-w-[560px] text-[15px] leading-[1.65] text-nocturne-neutral-400">
        Adding a sport should insert rows and write one provider adapter, with no migration and
        no change to scoring, drafting, trading, or settlement.
      </p>
    </section>
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
            Start a league nobody can rewrite.
          </h2>
          <p className="mt-6 max-w-[520px] text-[16px] leading-[1.65] text-nocturne-accent-200">
            Free leagues are open now. Create one, invite eleven people, and the rules you agree
            on are the rules the season runs on.
          </p>
          <div className="mt-9 flex flex-wrap items-center gap-3">
            <a
              href="/leagues/new"
              className="rounded-[4px] border border-nocturne-accent-300 px-[22px] py-3 text-[14.5px] text-nocturne-accent-100 transition-colors hover:bg-white/5"
            >
              Create a free league
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
