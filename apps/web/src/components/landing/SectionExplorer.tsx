"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import { LandingDraftBoard } from "./LandingDraftBoard";

/**
 * The seven panels, behind a rail — drop 7's landing page.
 *
 * Five scrolling bands became one band with a left rail. Two things about that
 * are the designer's own reasoning and worth keeping:
 *
 * **A rail rather than a carousel, because all seven labels stay visible.** In a
 * carousel, panels 2–6 are the whole argument and they sit behind two clicks.
 *
 * **Below the hero rather than inside it.** The original ask was to put this in
 * the hero's right column; that column is about 470×420 and the format table
 * alone is nine rows, so every panel would have collapsed to a headline or the
 * hero would have grown until the H1 left the screen.
 *
 * The order is a season rather than a menu: the argument leads because it is the
 * reason to keep reading, then the mechanics run in the order a manager meets
 * them — which puts the draft fourth rather than last. **Nothing auto-advances.**
 *
 * ## What is deliberately not the design's
 *
 * Three things the design states are wrong or stale, and are not copied:
 *
 * - The **roster-as-NFT** copy in panel 01. There is no NFT program and nothing
 *   has ever minted one; the claim was removed from this page on 2026-08-19 and
 *   must not come back. What is here is the half that was always true and is
 *   shipped — the trade escrow, the veto window, and the absence of any
 *   commissioner override.
 * - **Kickoff "September 10"** in the footer. It is the 9th: the first Week 1
 *   game is `20260909_NE@SEA`, confirmed against the synced schedule and by the
 *   owner.
 * - **"614 tests"**. That number is from a much older tree and would be wrong
 *   again next week, so the claim is made without one.
 */

const PANELS = [
  "Why it's different",
  "How it works",
  "Format",
  "The draft",
  "Inside a league",
  "Playoffs and payout",
  "Beyond football",
] as const;

export function SectionExplorer() {
  const [panel, setPanel] = useState(0);

  return (
    <section
      id="how"
      className="mx-auto w-full max-w-[1180px] scroll-mt-[60px] px-10 py-[84px]"
    >
      <div className="max-w-[640px]">
        <p className="text-[11px] tracking-[0.14em] text-nocturne-neutral-600 uppercase">
          A season, end to end
        </p>
        <h2 className="mt-4 text-[40px] leading-[1.1] font-medium tracking-[-0.028em]">
          Everything about how rostr works, in one place.
        </h2>
      </div>

      {/*
          Stacks below `lg`. The design does this with a media query on an
          `.explore` class defined in its own prototype stylesheet, which does
          not travel with the markup — carrying the class name across would
          have been a selector nothing applies, so the breakpoint is expressed
          the way the rest of this app expresses one.
        */}
      <div className="mt-12 grid gap-10 lg:grid-cols-[15rem_minmax(0,1fr)]">
        {/*
          The rail. Buttons rather than links: this changes what is shown, it does
          not navigate, and a list of anchors would put seven entries in the
          browser's history for one page.
        */}
        <nav aria-label="Sections">
          <ol className="space-y-1">
            {PANELS.map((label, index) => {
              const current = index === panel;
              return (
                <li key={label}>
                  <button
                    onClick={() => setPanel(index)}
                    aria-current={current ? "true" : undefined}
                    className={`flex w-full items-baseline gap-3 rounded px-3 py-2 text-left text-[13.5px] transition-colors ${
                      current
                        ? "bg-nocturne-accent/10 text-nocturne-text"
                        : "text-nocturne-neutral-500 hover:text-nocturne-text"
                    }`}
                  >
                    <span
                      className={`text-[11px] tabular-nums ${
                        current ? "text-nocturne-accent-300" : "text-nocturne-neutral-700"
                      }`}
                    >
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    {label}
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>

        {/*
          Keyed on the panel, so switching remounts and the fade replays. Without
          the key React reuses the subtree and the change reads as a jump.
        */}
        <div key={panel} className="min-w-0 animate-[rostrFade_260ms_ease-out]">
          {panel === 0 && <WhyDifferent />}
          {panel === 1 && <HowItWorks />}
          {panel === 2 && <Format />}
          {panel === 3 && <TheDraft />}
          {panel === 4 && <InsideALeague />}
          {panel === 5 && <PlayoffsAndPayout />}
          {panel === 6 && <BeyondFootball />}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ shared */

function PanelHead({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className="max-w-[680px]">
      <h3 className="text-[26px] leading-[1.15] font-medium tracking-[-0.024em]">{title}</h3>
      {children && (
        <p className="mt-3 text-[15px] leading-[1.6] text-nocturne-neutral-400">{children}</p>
      )}
    </header>
  );
}

function Note({ children }: { children: ReactNode }) {
  return (
    <p className="mt-6 border-l border-nocturne-neutral-800 pl-4 text-[13px] leading-[1.6] text-nocturne-neutral-600">
      {children}
    </p>
  );
}

/* --------------------------------------------------------------------- 01 */

function WhyDifferent() {
  return (
    <div>
      <PanelHead title="Every other fantasy platform asks you to trust an administrator.">
        This one doesn&rsquo;t. Four things move off the administrator&rsquo;s desk and into
        code.
      </PanelHead>

      <div className="mt-8 grid gap-4 sm:grid-cols-2">
        <Card index="01" title="Rules are immutable">
          A league&rsquo;s scoring, roster, payout split and deadlines are frozen at creation
          and shown in full before anyone joins. The rule set is hashed on-chain and joining is
          a signed transaction referencing that hash, so consent is cryptographic rather than a
          checkbox.
          <Aside>
            No commissioner can rewrite scoring in Week 10 because their team is losing.
          </Aside>
        </Card>

        <Card index="02" title="The pot is escrowed">
          Optional per league. Everyone deposits the same amount of the same token, and funds
          unlock only when the season resolves. No treasurer holding a Venmo balance until
          March.
          <Aside>
            Not live yet — the settlement instruction is unwritten, so pot leagues cannot take a
            deposit today.
          </Aside>
        </Card>

        <Card index="03" title="Nobody declares a winner">
          The contract holds the bracket, the scores, and the rules, and derives the champion
          from the Week 17 result. There is no sign-off step to corrupt.
        </Card>

        {/*
          The design still says drafted players mint as Token-2022 NFTs held in
          your wallet. Nothing has ever minted one, there is no NFT program, and
          the roster-as-NFT design was abandoned on 2026-08-19 — the enforcement
          it needed existed only to stop a roster being sold out from under a
          league, which the database already prevents.

          What is left is the half that was true all along and is shipped. Do not
          restore an NFT sentence here until something actually mints.
        */}
        <Card index="04" title="Your roster is yours">
          A trade freezes both sides the moment it is accepted, then waits out a 48-hour window
          in which a third of the uninvolved managers can veto it. No commissioner can force one
          through, reverse one, or edit a roster — there is no such function to call.
        </Card>
      </div>
    </div>
  );
}

function Card({
  index,
  title,
  children,
}: {
  index: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-nocturne-neutral-900 p-5">
      <span className="text-[11px] tabular-nums text-nocturne-neutral-700">{index}</span>
      <h4 className="mt-2 text-[17px] font-medium tracking-[-0.014em]">{title}</h4>
      <div className="mt-2 text-[14px] leading-[1.6] text-nocturne-neutral-400">{children}</div>
    </div>
  );
}

function Aside({ children }: { children: ReactNode }) {
  return <p className="mt-3 text-[13px] text-nocturne-neutral-600">{children}</p>;
}

/* --------------------------------------------------------------------- 02 */

const STEPS = [
  {
    step: "Step 1",
    title: "Create or join",
    body: "Sign in with email, pick a username, link a wallet by signature. Every rule is shown in full before you commit — then it is frozen.",
  },
  {
    step: "Step 2",
    title: "Draft",
    body: "Snake draft with the order drawn from a Solana block, so nobody picked it. Fast at 90 seconds a pick, or slow up to 24 hours. Queue players and let autopick cover you.",
  },
  {
    step: "Step 3",
    title: "Play the season",
    body: "Weeks 1–14, head-to-head. Set lineups, work the waiver wire, trade through the veto window. Schedule luck stays in, deliberately.",
  },
  {
    step: "Step 4",
    title: "Settle",
    body: "Playoffs Weeks 15–17, championship in Week 17. The contract reads the result and pays out. Nobody signs anything off.",
  },
] as const;

function HowItWorks() {
  return (
    <div>
      <PanelHead title="Four steps, one season.">
        From an empty league to a settled pot, without a commissioner adjudicating anything.
      </PanelHead>

      <ol className="mt-8 grid gap-4 sm:grid-cols-2">
        {STEPS.map((entry) => (
          <li key={entry.step} className="rounded-lg border border-nocturne-neutral-900 p-5">
            <span className="text-[11px] tracking-[0.12em] text-nocturne-accent-300 uppercase">
              {entry.step}
            </span>
            <h4 className="mt-2 text-[17px] font-medium tracking-[-0.014em]">{entry.title}</h4>
            <p className="mt-2 text-[14px] leading-[1.6] text-nocturne-neutral-400">
              {entry.body}
            </p>
          </li>
        ))}
      </ol>

      <Note>
        A league can be created, joined and drafted end to end today. Settlement and the pot are
        the parts still being written, which is why nothing takes money yet.
      </Note>
    </div>
  );
}

/* --------------------------------------------------------------------- 03 */

const FORMAT = [
  [
    "Scoring",
    "Full PPR. 4pt passing TD, 6pt rushing and receiving TD, 1pt per 25 passing yards, 1pt per 10 rushing or receiving yards, −2 per interception and lost fumble.",
  ],
  [
    "Teams",
    "12, minimum 2 humans. One bot is available in a free league, and only to square an odd field — three humans plus a bot makes four.",
  ],
  [
    "Roster",
    "9 starters and 5 bench, plus 2 injured-reserve slots that do not count against the limit.",
  ],
  ["Draft", "Snake. Fast (90s minimum) or slow (up to 24h per pick)."],
  [
    "Season",
    "Weeks 1–14 regular season, 15–17 playoffs, championship Week 17. Week 18 is excluded — NFL starters rest once seeding is settled.",
  ],
  ["Matchups", "Head-to-head, weekly."],
  ["Waivers", "Rolling priority. Win a claim, go to the back of the order."],
  [
    "Trades",
    "Through escrow, with a 48-hour league veto window. A third of the uninvolved managers can stop one.",
  ],
  [
    "Consolation",
    "Played, so eliminated teams still have something to play for. This is the anti-abandonment mechanism — punishment does not work on someone already guaranteed nothing.",
  ],
] as const;

function Format() {
  return (
    <div>
      <PanelHead title="The default league, in full.">
        This is the whole rule set, not a summary of it. Every value is also rendered above the
        join control of any league that uses it, before anyone signs.
      </PanelHead>

      <dl className="mt-8 divide-y divide-nocturne-neutral-900 border-y border-nocturne-neutral-900">
        {FORMAT.map(([term, definition]) => (
          <div key={term} className="grid gap-2 py-4 sm:grid-cols-[9rem_minmax(0,1fr)]">
            <dt className="text-[13.5px] font-medium text-nocturne-neutral-400">{term}</dt>
            <dd className="text-[14px] leading-[1.6] text-nocturne-neutral-400">
              {definition}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/* --------------------------------------------------------------------- 04 */

function TheDraft() {
  return (
    <div>
      <PanelHead title="Nobody picks the draft order.">
        It is drawn from a Solana block produced after the deadline to join, so it does not
        exist until the moment it is drawn. Anyone can recompute it from the blockhash.
      </PanelHead>

      <div className="mt-8 grid gap-8 xl:grid-cols-[minmax(0,1fr)_18rem]">
        <LandingDraftBoard />

        <div className="rounded-lg border border-nocturne-neutral-900 p-5">
          <h4 className="text-[13px] tracking-[0.12em] text-nocturne-neutral-500 uppercase">
            The draw, verifiable
          </h4>
          <dl className="mt-4 space-y-3 text-[13px]">
            {[
              ["Slot", "312,884,109"],
              ["Block time", "22 Aug, 20:00:03 ET"],
              ["Previous", "20:00:02 ET"],
              ["Seed", "blockhash + league id"],
            ].map(([term, value]) => (
              <div key={term} className="flex justify-between gap-3">
                <dt className="text-nocturne-neutral-600">{term}</dt>
                <dd className="text-right tabular-nums text-nocturne-neutral-300">{value}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-4 text-[12px] leading-[1.55] text-nocturne-neutral-600">
            One second separates this block from the one before it, which is what makes it the
            only block the league could have used.
          </p>
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------- 05 */

const LINEUP = [
  ["QB", "J. Goff", "DET", "21.4", "24.8"],
  ["RB", "B. Robinson", "ATL", "14.9", "18.1"],
  ["WR", "N. Collins", "HOU", "16.2", "9.4"],
  ["FLEX", "J. Cook", "BUF", "11.7", "15.6"],
  ["TE", "T. Kraft", "GB", "9.3", "—"],
] as const;

const WEEKLY = [
  "Head-to-head weekly matchups, Weeks 1–14",
  "Rolling waiver priority: win a claim, go to the back",
  "Trades sit in escrow for 48 hours so the league can veto",
  "Lineups lock per player, at that player's own kickoff",
  "Consolation bracket is played, so nobody is out of it",
] as const;

function InsideALeague() {
  return (
    <div>
      <PanelHead title="The week you already know how to read.">
        Matchups, projections, waiver order, a starting lineup that autofills if you miss
        kickoff. Nothing about the format is novel — the format is the part that works. What
        changes is who holds the rules.
      </PanelHead>

      <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1fr)_16rem]">
        <div className="overflow-hidden rounded-lg border border-nocturne-neutral-900">
          <div className="flex items-baseline justify-between gap-3 border-b border-nocturne-neutral-900 px-5 py-3">
            <span className="text-[13.5px] font-medium">Dynasty of Dropped Passes</span>
            <span className="text-[11px] text-nocturne-neutral-600">Week 3</span>
          </div>

          <div className="flex items-center justify-between gap-4 border-b border-nocturne-neutral-900 px-5 py-4">
            <span className="min-w-0">
              <span className="block truncate text-[14px]">Route 66</span>
              <span className="block text-[11px] text-nocturne-neutral-600">
                2–0 · proj 118.4
              </span>
            </span>
            <span className="shrink-0 text-[15px] tabular-nums">
              86.2 <span className="text-nocturne-neutral-700">vs</span> 71.9
            </span>
            <span className="min-w-0 text-right">
              <span className="block truncate text-[14px]">Tuesday Night Regrets</span>
              <span className="block text-[11px] text-nocturne-neutral-600">
                1–1 · proj 104.8
              </span>
            </span>
          </div>

          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-[10px] tracking-[0.1em] text-nocturne-neutral-600 uppercase">
                <th className="px-5 py-2 text-left font-medium">Slot</th>
                <th className="py-2 text-left font-medium">Starter</th>
                <th className="py-2 text-right font-medium">Proj</th>
                <th className="px-5 py-2 text-right font-medium">Pts</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-nocturne-neutral-900">
              {LINEUP.map(([slot, name, team, proj, pts]) => (
                <tr key={slot}>
                  <td className="px-5 py-2 text-nocturne-neutral-500">{slot}</td>
                  <td className="py-2">
                    {name} <span className="text-nocturne-neutral-600">{team}</span>
                  </td>
                  <td className="py-2 text-right tabular-nums text-nocturne-neutral-500">
                    {proj}
                  </td>
                  <td className="px-5 py-2 text-right tabular-nums">{pts}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <p className="border-t border-nocturne-neutral-900 px-5 py-3 text-[11px] text-nocturne-neutral-600">
            Autolineup on · waiver priority 12 of 12
          </p>
        </div>

        <ul className="space-y-3 text-[13.5px] leading-[1.55] text-nocturne-neutral-400">
          {WEEKLY.map((line) => (
            <li key={line} className="flex gap-2">
              <span aria-hidden className="text-nocturne-neutral-700">
                —
              </span>
              {line}
            </li>
          ))}
        </ul>
      </div>

      <Note>
        Scores stay provisional until 48 hours after a week&rsquo;s last game, because the NFL
        issues stat corrections for up to seven days.
      </Note>
    </div>
  );
}

/* --------------------------------------------------------------------- 06 */

const ROUNDS = [
  {
    week: "Week 15 · quarterfinals",
    games: [
      ["3 Route 66", "W", "6 Gridiron Heresy", "L"],
      ["5 Audibles", "W", "4 Hail Mary Inc.", "L"],
    ],
    note: "Seeds 1 and 2 are on a bye.",
  },
  {
    week: "Week 16 · semifinals",
    games: [
      ["1 Pylon Co.", "W", "5 Audibles", "L"],
      ["3 Route 66", "W", "2 Cover Two", "L"],
    ],
    note: "Survivors reseed, so the 1 draws the 5 and the 3 draws the 2 — not the pairings the first round implied.",
  },
] as const;

const DERIVATION = [
  "The frozen rule set says Week 17 decides it.",
  "Two stat providers agree on the week's numbers.",
  "Scores finalise 48 hours after the last game.",
  "The contract reads the result and pays out.",
] as const;

function PlayoffsAndPayout() {
  return (
    <div>
      <PanelHead title="The bracket reseeds, and the contract does the rest.">
        Six teams across Weeks 15 to 17. Every round reseeds — the best surviving seed always
        draws the worst — so the bracket cannot be drawn in advance. An upset changes who the
        top seed plays, not just who survives.
      </PanelHead>

      <div className="mt-8 space-y-5">
        {ROUNDS.map((round) => (
          <div key={round.week} className="rounded-lg border border-nocturne-neutral-900 p-5">
            <h4 className="text-[11px] tracking-[0.12em] text-nocturne-neutral-500 uppercase">
              {round.week}
            </h4>
            <ul className="mt-3 space-y-2 text-[13.5px]">
              {round.games.map(([home, homeResult, away, awayResult]) => (
                <li key={home} className="flex flex-wrap items-baseline gap-x-3">
                  <span className="text-nocturne-text">{home}</span>
                  <span className="text-[11px] text-nocturne-accent-300">{homeResult}</span>
                  <span className="text-nocturne-neutral-700">·</span>
                  <span className="text-nocturne-neutral-500">{away}</span>
                  <span className="text-[11px] text-nocturne-neutral-700">{awayResult}</span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-[12px] text-nocturne-neutral-600">{round.note}</p>
          </div>
        ))}

        <div className="rounded-lg border border-nocturne-accent/30 p-5">
          <h4 className="text-[11px] tracking-[0.12em] text-nocturne-neutral-500 uppercase">
            Week 17 · championship
          </h4>
          <ul className="mt-3 space-y-2 text-[13.5px]">
            <li className="flex justify-between gap-3">
              <span>3 Route 66</span>
              <span className="tabular-nums text-nocturne-accent-200">132.8</span>
            </li>
            <li className="flex justify-between gap-3 text-nocturne-neutral-500">
              <span>1 Pylon Co.</span>
              <span className="tabular-nums">128.1</span>
            </li>
          </ul>
          <p className="mt-3 text-[12px] text-nocturne-neutral-600">
            Third place is played too, so the loser of a semifinal still has a game.
          </p>
        </div>
      </div>

      <div className="mt-8">
        <h4 className="text-[13px] tracking-[0.12em] text-nocturne-neutral-500 uppercase">
          How the champion is derived
        </h4>
        <ol className="mt-3 space-y-2 text-[13.5px] text-nocturne-neutral-400">
          {DERIVATION.map((line, index) => (
            <li key={line} className="flex gap-3">
              <span className="text-[11px] tabular-nums text-nocturne-neutral-700">
                {index + 1}
              </span>
              {line}
            </li>
          ))}
        </ol>
      </div>

      <Note>
        There is no sign-off step. A week that pays out waits the full seven days the NFL allows
        for stat corrections rather than 48 hours.
      </Note>
    </div>
  );
}

/* --------------------------------------------------------------------- 07 */

const SPORT = [
  ["Stays the same", "Leagues, rosters, drafting, trades, waivers, escrow, settlement."],
  [
    "Comes from data",
    "Positions, lineup slots, stat keys, scoring weights, the season calendar.",
  ],
  ["Written once per sport", "One provider adapter that maps a feed onto those stat keys."],
] as const;

function BeyondFootball() {
  return (
    <div>
      <PanelHead title="The schema does not know what football is.">
        Football ships first, but sports are data — a registry of stat keys, positions and
        lineup slots — never structure or code branches. Adding a sport should insert rows and
        write one provider adapter, with no migration and no change to scoring, drafting,
        trading or settlement.
      </PanelHead>

      <div className="mt-8 grid gap-4 sm:grid-cols-3">
        {SPORT.map(([title, body]) => (
          <div key={title} className="rounded-lg border border-nocturne-neutral-900 p-5">
            <h4 className="text-[13.5px] font-medium">{title}</h4>
            <p className="mt-2 text-[13.5px] leading-[1.55] text-nocturne-neutral-400">
              {body}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
