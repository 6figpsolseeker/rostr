Branch: `design/screens`

---

## Design drop 6 — landing hero rebuilt from the shipped draft board

Twelve screen files plus an index, covering rostr end to end: the public landing page,
creating and freezing a league, inviting and joining it, the draft lobby and the order draw,
the draft room and its failure branches, the weekly in-season loop including the full trade
flow, the playoffs and settlement, amend and dissolve, and eight screens designed for mobile
web.

Nothing here is wired into `apps/web`. `design_handoff/` is the reference to build against.

### What changed since drop 5

**The landing hero has a right column now — a condensed live draft board — and it is built
from `DraftRoom.tsx` rather than invented.** The first attempt was a monochrome grid of
position abbreviations; it was rejected, correctly, for not being the product. The rebuild
reproduces the shipped component exactly:

- Cells filled **by position** from `POSITION_COLOURS` in `lib/player.ts` — QB rose, RB
  emerald, WR sky, TE amber, at 0.15 alpha with 0.3 rings.
- Team names head the columns, with the `you` / `bot` tag beneath.
- Each row carries a **direction arrow**, because the snake reversal is the one thing people
  get wrong when planning two picks ahead.
- Columns hold the real `min-w-[7.5rem]` floor. **Three of twelve teams at full width, not
  twelve squeezed** — below 120px `shortName`'s surnames truncate, which defeats the reason
  the given name is initialled at all.
- The on-clock card's portrait is a 96px slot, the size `PlayerAvatar` documents for a card
  portrait.

Two implementation notes worth carrying over. The crop fade is a **fixed-length** gradient,
not a percentage — the aside doubles in width when the layout stacks, and a percentage fade
eats a whole visible column at the wider size. And real headshots come from the provider's
`imageUrl` through `sizedImage`; the design shows initialled discs because no photo assets
exist here, but in production the disc is the one-in-ten fallback, not the normal case.

**Nav consolidated to four items** at the user's request: How it works, a GitHub icon and an
X icon, Create a league, Connect wallet. The separate Format and Why it's different tabs are
gone — `#how` now covers all three sections contiguously, with the sub-sections demoted to
h3 and their cards to h4.

**Connect wallet is a `<button>`, not an anchor.** Connecting is an action, not a
destination, and it needs a real affordance — which makes it a **fourth surface requiring
the wallet signing round-trip**, alongside freezing a league, voting, and pot actions.

**The scoring table on the create-league freeze screen now matches `NFL_PPR_SCORING`.**
Whoever wrote `design-scoring.test.ts` was right — the design had a 10-point shutout against
the rule set's 5, field goals stopping at 50+, no miss penalty and no yards-allowed ladder.
All of it is now pulled from the rule set, plus the extra point, which was missing from the
table but present in the code.

### Read the README's second section first

Most defects found while designing these were not visual. They were the same league
described inconsistently in two places — including, this round, twice within a single file:
the new hero board initially gave Route 66 a roster that contradicted the League home panel
800px below it, because it was keyed off the page's older name set on the assumption that
set was still current.

The README lists the eleven facts that must be **derived from one source and never
restated**. That table is the most useful thing in the bundle.

### Still open, and needing you rather than a developer

- **How autopick signs a transaction the manager was not present for.** Session key,
  pre-authorization at draft start, or a delegated signer. This also creates draft room
  state 6, where a manager loses the player they chose because a wallet prompt outlived its
  blockhash. Settle it before the escrow program is written; the notice strip reads "signed
  0x7f3a…c19d" without claiming a mechanism, and should not ship until one is real.
- **Which hero animation ships, A or B.** Both are in the file behind a switcher. One is
  dead weight a developer has to delete.
- **Kickoff is 9 September in `README.md` and 10 September across all twelve designs.**
  9 Sept 2026 is a Wednesday and NFL Week 1 opens Thursday, so I believe the README is
  wrong — but it is your call and it is now stated in two places.
- **When a week label flips.** The trade and amend screens label Tuesday 17 Nov as Week 10,
  after Week 10's games are finished and before Week 11's start. Most platforms would call
  that Week 11. No arithmetic in the designs depends on it; the developer needs one rule.
- **Whether escrow release can move a player whose game is already in progress.** A trade
  accepted late Tuesday has its 48-hour window close Thursday evening, which is kickoff.
  The designs dodge the collision by timestamp rather than by rule.

### Not done

- Five desktop screens have no mobile design — create league, the commissioner's invite
  side, draft lobby, trades, amend and dissolve — and neither does the playoff bracket,
  which is the hard one: three reseeded rounds will not sit side by side at 390px.
- Player detail, full standings.
- Every player name is invented. Swap for Tank01 before showing this to anyone.
