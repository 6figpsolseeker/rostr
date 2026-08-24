/**
 * What's coming, on a numbered spine.
 *
 * Drop 10's band, with the owner's copy verbatim. **A top-level section, not an
 * eighth panel in `SectionExplorer`** — the explorer describes how the product
 * works today, and somebody looking for future features should not have to
 * click through seven tabs about the present to find them.
 *
 * ## One stage is accent and five are not
 *
 * Stage 01's number, spine and hover wash are accent; 02–06 are neutral. Its
 * pill is the only filled one and the only animated one. That is the whole
 * information design: a glance separates "running today" from "not yet", and if
 * every stage glowed, nothing would mark the live one.
 *
 * ## The CSS trap, measured by the designer rather than found in production
 *
 * The card's negative margin is **left-only** and the section sets
 * `overflow-x: clip`. With a symmetric `-22px` the resting card overhangs its
 * container by 22px and the hover adds `0.022 × cardWidth` on top — at a 1180px
 * container that is 47px against 40px of padding, so a horizontal scrollbar
 * flickers in and out as the mouse crosses the roadmap, at every viewport
 * between roughly 923px and 1275px. `clip` rather than `hidden` because it
 * creates no scroll container.
 *
 * ## Every stage ends on its own honesty line
 *
 * Same position each time, so the labelling is structural rather than a caveat
 * somebody remembered to add — "Not started · no NFT code exists in the
 * repository today" sits exactly where "Kickoff 9 September 2026" does. That
 * consistency is what stops a roadmap reading as six promises.
 */

interface Stage {
  readonly number: string;
  readonly title: string;
  /** Rendered as the pulsing pill. Exactly one stage may carry it. */
  readonly live?: boolean;
  readonly when: string;
  /** Paragraphs, in order. The first is emphasised. */
  readonly body: readonly string[];
  /** The hairline at the foot: what is true today, however plain. */
  readonly status: string;
}

const STAGES: readonly Stage[] = [
  {
    number: "01",
    title: "Season-long leagues",
    live: true,
    when: "2026 season",
    body: [
      "Create a league, invite eleven people, draft, and play a full NFL season. Scoring, roster limits, waivers, trades and playoffs are decided by rules frozen and hashed before anyone joins.",
      "Free to play. No buy-in and no pot — deliberately, for the first season.",
      "The draft order is drawn from a Solana block nobody could pick in advance, and the rules your league agreed to are anchored on-chain where nobody can edit them afterwards. Not a commissioner, and not us.",
    ],
    status: "Kickoff 9 September 2026 · the season settles in January",
  },
  {
    number: "02",
    title: "More sports",
    when: "Q4 2026",
    body: [
      "Football ships first because football is where the players are. Nothing in the engine knows it is football.",
      "Sports are data here — a registry of stat keys, positions and lineup slots — never branches in the code. Adding a sport means inserting rows and writing one provider adapter: no migration, and no change to scoring, drafting, trading or settlement.",
      "That isn't an aspiration. It's why the scoring engine can be tested against an invented cricket rule set today.",
    ],
    status: "Basketball tips off in October · the registry exists, NFL is the only sport in it",
  },
  {
    number: "03",
    title: "Daily fantasy",
    when: "Q4 2026",
    body: [
      "One week. One lineup. Winner takes the pot.",
      "Salary cap, no season commitment, no draft, no waiver wire. Pick a team under a fixed budget — the better a player has been, the more of your cap he costs — and the highest score wins. Enter for a few dollars; play against everyone who did the same.",
      "The pot is escrowed, not promised. Every entry fee goes into a vault on Solana that no person holds the keys to, and the payout is derived from the final scores by a program. Nobody approves it. Nobody can decide you didn't win. There is no house edge you have to take on trust — the split is published before you enter.",
      "The cap, the player prices and the prize split are frozen before entries open. Nobody reprices a player after lineups lock.",
    ],
    status: "Buy in from $5 · paid out automatically when the slate ends",
  },
  {
    number: "04",
    title: "Season-long pots",
    when: "Q2–Q3 2027",
    body: [
      "Buy-in leagues, on the escrow daily fantasy has spent a season proving.",
      "A weekly contest holds your money for four days. A season-long pot holds it from August to January — so it gets the escrow second, once the same program has settled hundreds of slates in public. Same vault nobody holds the keys to, same settlement derived from posted scores rather than declared by anyone. No commissioner sign-off, no vote, no discretion. An unconditional refund opens on a date fixed when the league is created, so money can always come back out.",
    ],
    status: "The escrow is built · season-long pots are not started",
  },
  {
    number: "05",
    title: "Your roster, in your wallet",
    when: "Q2–Q3 2027",
    body: [
      "Draft a player and he is minted to you — a compressed NFT you hold, not a row in our database.",
      "He cannot be moved out of it. Not sold, not transferred, not lifted by anything holding your keys. The only things that shift a player are the ones the league already understands: a trade both managers accepted, a drop, a waiver claim. The rules move your roster; nothing else can.",
      "That matters because a roster is not a collectible. A team sold out from under a league mid-season breaks the season for eleven other people, so the token is built to make it impossible rather than discouraged.",
      "Compressed, so a full twelve-team league mints its entire 168-player roster for a fraction of a cent. A souvenir you paid gas for is a souvenir nobody wants.",
    ],
    status: "Not started · no NFT code exists in the repository today",
  },
  {
    number: "06",
    title: "Native apps",
    when: "Q3–Q4 2027",
    body: [
      "Native apps, on the Solana Seeker dApp Store, Google Play and the App Store.",
      "Seeker first, because it is the phone this product was designed for: the wallet is in the operating system, so joining a league, staking a contest and signing your lineup happen without a browser extension or a popup that steals focus. Mobile Wallet Adapter and Seed Vault do the part that is awkward everywhere else.",
      "The rest follows for everyone who does not have one. Same leagues, same contests, same rules — a draft board built for a thumb rather than a mouse, and a lineup you can set from a car park before kickoff.",
    ],
    status: "Not started · the mobile design is drawn, nothing is built",
  },
];

export function Roadmap() {
  return (
    // `overflow-x-clip` is load-bearing — see the note at the top of this file.
    <section id="roadmap" className="overflow-x-clip px-10 pt-[76px] pb-24">
      <div className="mx-auto w-full max-w-[1180px]">
        <div className="text-[11px] tracking-[0.14em] text-nocturne-accent-500 uppercase">
          What&rsquo;s coming
        </div>
        <h2 className="mt-3.5 text-[38px] leading-[1.1] font-medium tracking-[-0.028em]">
          Built in the open, shipped in order.
        </h2>
        <p className="mt-4 max-w-[660px] text-[15.5px] leading-[1.62] text-nocturne-neutral-400">
          Every stage is either running today or honestly labelled as not. The dates are
          targets, not promises &mdash; what&rsquo;s fixed is the order.
        </p>

        <ol className="mt-[34px] flex list-none flex-col p-0">
          {STAGES.map((stage) => (
            <li
              key={stage.number}
              className="grid grid-cols-[46px_minmax(0,1fr)] gap-[22px] pb-[34px]"
            >
              <span className="flex flex-col items-center gap-2.5">
                <span
                  className={`font-mono text-[12px] ${
                    stage.live ? "text-nocturne-accent-300" : "text-nocturne-neutral-500"
                  }`}
                >
                  {stage.number}
                </span>
                {/*
                  The spine. Accent only under the live stage, so the eye is
                  drawn down from what is running rather than along six equals.
                */}
                <span
                  className={`w-px flex-1 ${
                    stage.live
                      ? "bg-gradient-to-b from-nocturne-accent-700 to-nocturne-neutral-800"
                      : "bg-nocturne-neutral-800"
                  }`}
                />
              </span>

              <div
                className={`rostr-stage min-w-0 rounded-lg border border-transparent py-[18px] pr-[22px] pl-[22px] -my-[18px] -ml-[22px] ${
                  stage.live
                    ? "hover:border-nocturne-accent-800 hover:bg-nocturne-accent/[0.07]"
                    : "hover:border-nocturne-neutral-800 hover:bg-white/[0.03]"
                }`}
              >
                <div className="flex flex-wrap items-baseline gap-3">
                  <h3 className="text-[22px] font-medium tracking-[-0.02em]">{stage.title}</h3>

                  {stage.live && (
                    <span className="inline-flex items-center gap-[7px] rounded-full bg-nocturne-accent/[0.18] py-[3px] pr-2.5 pl-2 text-[10px] font-semibold tracking-[0.14em] text-nocturne-accent-100 uppercase ring-1 ring-nocturne-accent-700 ring-inset">
                      <span className="relative inline-flex h-1.5 w-1.5">
                        <span className="absolute inset-0 animate-[rostrLiveHalo_2.2s_ease-out_infinite] rounded-full bg-nocturne-accent" />
                        <span className="relative h-1.5 w-1.5 animate-[rostrLivePulse_2.2s_ease-in-out_infinite] rounded-full bg-nocturne-accent-200" />
                      </span>
                      Live
                    </span>
                  )}

                  <span className="text-[12.5px] text-nocturne-neutral-500">{stage.when}</span>
                </div>

                {stage.body.map((paragraph, index) => (
                  <p
                    key={paragraph.slice(0, 32)}
                    className={`mt-3 max-w-[680px] text-[14.5px] leading-[1.65] ${
                      // The first paragraph is the claim; the rest support it.
                      index === 0 ? "text-nocturne-neutral-300" : "text-nocturne-neutral-400"
                    }`}
                  >
                    {paragraph}
                  </p>
                ))}

                <div className="mt-4 border-t border-nocturne-neutral-900 pt-[13px] text-[12.5px] text-nocturne-neutral-500">
                  {stage.status}
                </div>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
