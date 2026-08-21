# rostr — design handoff

Twelve screen files plus an index and a logo sheet, covering the whole product as it exists
today: the public landing page, creating and freezing a league, inviting and joining it, the draft lobby and
the order draw, the draft room, the weekly in-season loop, the playoffs and settlement, amending and dissolving a league,
and ten screens designed for mobile web.

## About these files

Everything in `screens/` is a **design reference created in HTML** — a prototype of look,
layout and copy, not production code to lift. Each `.dc.html` opens directly in a browser
and needs `support.js` beside it; that runtime is a prototyping tool and must not ship.

The task is to recreate these designs in `apps/web` using the repo's existing Next.js /
React / TypeScript patterns. Take the structure, the exact values and the copy from here;
express them however `apps/web` already expresses things.

**Fidelity: high.** Colors, type, spacing and copy are final. Every screen stacks its
states vertically behind a `STATE n` caption, so one file is several designs.

**Eleven screens are desktop, pinned `min-width: 1280px`.** `Rostr Mobile.dc.html` carries
the mobile web designs — six screens at 390px, the narrowest common phone width, each in a
browser frame. Mobile is a different design, not a reflow: navigation moves to a bottom bar,
the draft board becomes a tab, drag-and-drop is gone, and tables collapse to three columns.
Five desktop screens still have no mobile design (create league, the commissioner's invite
side, draft lobby, amend and dissolve) and neither does the playoff bracket, which is
the hard one — three reseeded rounds will not sit side by side at 390px.

## Read this section before you build anything

Nine of the roughly twelve defects found while designing these screens were not visual.
They were **the same league described inconsistently across two files** — a 6-team lobby
feeding a 12-team draft room, a roster limit of 15 on one screen and 14 on the next, a
48-hour veto window whose timestamps spanned 77 hours, a player starting on Sunday and on
injured reserve since Friday, standings ordered against their own stated tiebreaker.

That is not a prototype problem. It is what happens when the same fact is authored twice,
and it will happen in the codebase for exactly the same reason. **Derive these from one
source, never restate them:**

| Fact | Where it must come from |
| --- | --- |
| Roster limit | The rule set. 9 starters + 5 bench = **14**, plus 2 IR that do **not** count against it. |
| Standings order | Computed from results by the §5 tiebreakers, never authored. A team mid-game carries a record one game shorter than a team whose week is final. |
| Veto threshold | `ceil(uninvolved_managers / 3)`. 12 teams − 2 involved = 10 → **4**. Managers, not teams: bots cannot vote. |
| Veto deadline | `escrowed_at + 48h`. Every countdown on every screen reads from that one timestamp. |
| Draft order and pick numbers | The published draw. Position *p* in a 12-team snake picks `p` in R1 and `25 − p` in R2. Route 66 is position 4 → 1.04, 2.09, 3.04. |
| Autofill target | Recomputed after every roster change: highest projection eligible for the slot, scarce slots first, ties by ascending player ID. |
| Positional need (the accent) | Recomputed after every one of your own picks — the accent tracks *unfilled starting slots*, not position identity. |
| Lock state | Per player, at that player's own kickoff. Never a league-wide deadline. |
| Season dates | One calendar. Week 1 opens **Thu 10 September 2026**; Week 17 is the championship. This was authored three different ways across three screens before it was caught. |
| Picks between two of your own | Snake arithmetic, never counted by hand. From 3.04 to 4.09 is 16; from 3.07 to 4.09 is 13. |
| Bracket shape | `buildBracket` walked from round one on every call. Never a stored `winner_team_id`. |
| Unanimity denominator | Stake-holding managers. A bot has no wallet and paid no buy-in, so it neither signs nor blocks — the same exclusion as the veto denominator. |

## The canonical demo league

Every screen describes one league. Keep it that way; a demo that contradicts itself
undoes the argument these screens exist to make.

**Dynasty of Dropped Passes** — private, 12 human teams, no bot (a bot is only permitted
to square an odd field), full PPR, snake draft, fast pace, 90-second clock, no pot.
Rules frozen 13 Aug 2026, hash `0x7f3a…c19d`. Draft drawn from Solana slot 312,884,109 at
20:00:03 ET on 22 Aug 2026.

Draft order, which is also the draft board's column order:

| # | Team | | # | Team |
| --- | --- | --- | --- | --- |
| 1 | Backfield Ballers | | 7 | Fourth and Long |
| 2 | Hail Mary Inc. | | 8 | Bye Week Blues |
| 3 | Pylon Co. | | 9 | Audibles |
| **4** | **Route 66** — the user, and commissioner | | 10 | Red Zone Rentals |
| 5 | Tuesday Night Regrets | | 11 | Play Action Only |
| 6 | Gridiron Heresy | | 12 | Cover Two |

**Route 66's roster** (drafted at 1.04, 2.09, 3.04, then later rounds):

| Slot | Player | | Bench | | IR |
| --- | --- | --- | --- | --- | --- |
| QB | J. Whitcombe PIT | | D. Achterberg NO | WR | K. Osei-Bonsu LV (ruled out W4) |
| RB | L. Marchetti MIN | | C. Ibarra NYG | TE | S. Baptiste CLE |
| RB | A. Villanueva TEN | | T. Bergström HOU | RB | |
| WR | K. Osei-Bonsu LV | | P. Håkansson DEN | WR | |
| WR | W. Adeyemi SF | | E. Nwachukwu JAX | WR | |
| TE | M. Lindqvist ARI | | | | |
| FLEX | N. Osterberg CAR | | | | |
| K | R. Duclos NO | | | | |
| DEF | Pittsburgh | | | | |

**All player names are invented.** Swap for Tank01 data on implementation — players, ADP
and projections all come from the existing stats adapter. Derive board, roster, queue and
pool from **one** pick list; the prototype briefly had a player both drafted and
available, which is precisely the bug a single source removes.

## Design system

Nocturne. `nocturne/styles.css` is the full token sheet plus component layer — port its
`:root` block as the token source. The rules that govern every screen here:

- The accent `#9184d9` is **a line, an edge and a tint, never a fill covering area**. One
  saturated ground in the whole set: the landing page's closing band.
- Buttons are **outlined**, never solid.
- Horizontal rules **fade to transparent at both ends** over ≥48px — which is why every
  divider is a `linear-gradient(90deg, transparent, …, transparent)` and not a border.
- `--color-neutral-700` and darker are **borders and fills only**. Any text carrying
  information uses 600 or lighter; 700 on `--color-surface` measures 2.35:1 and fails.
  Labels at 10px go to 500.
- **Never dim a row of copy to convey a disabled state.** `opacity: 0.4` on a row put real
  information at 1.65:1 twice in this project — on the create-league pot block and on the
  lineup's ineligible slots. Dim the *affordance* (the button, the pill); leave names,
  times, values and the reason-why at full ramp.
- Elevation is a hairline edge plus ambient dark (`--shadow-sm: 0 0 0 1px #3f424d`). Do
  not stack shadows.
- Headings cap at weight 500. Hierarchy is size and space.
- Every interactive element needs a hover tint, a pressed state from the accent ramp, and
  `:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px }`. A
  styled `<span>` standing in for an action is a defect — it happened once here, on the
  invite screen's Resend.

### Tokens in use
`--color-bg` #161826 · `--color-surface` #232532 · `--color-text` #e9e9ed ·
`--color-accent` #9184d9 · accent ramp 100–900 · neutral ramp 100–900 ·
`--color-section` #262a60 and `--color-section-glow` #353b80 (landing close only) ·
`--radius-sm` 4px, `--radius-md` 8px, `--radius-lg` 14px · `--shadow-sm/md/lg`.

Three `color-mix` tints, used consistently across all nine screens:

- `color-mix(in srgb, var(--color-accent) 8-9%, transparent)` — a highlighted row, or an
  informational strip
- `color-mix(in srgb, var(--color-accent) 12-18%, transparent)` — an active control, a
  banner, the on-the-clock cell
- `color-mix(in srgb, var(--color-accent) 13%, var(--color-surface))` — your own cells in
  the draft board

### Type
Inter 400/500/600, `--font-heading` and `--font-body` both. Numerals use
`font-variant-numeric: tabular-nums` everywhere. Pick identifiers, hashes, ranks and round
labels use `ui-monospace, monospace`.

| Element | Size | Weight | Tracking |
| --- | --- | --- | --- |
| Landing h1 | `clamp(46px, 6.2vw, 86px)` | 500 | −0.035em |
| Draft clock | 40px | 500 | −0.03em |
| Lobby countdown | 76px | 500 | −0.04em |
| Matchup score | 62px | 500 | −0.035em |
| Screen h1 | 28–34px | 500 | −0.026em |
| Section h2 | 19–20px | 500 | −0.018em |
| Body | 13.5–15px | 400 | — |
| Table body | 13–13.5px | 400 | — |
| Section kicker | 10.5px | 400 | 0.14em, uppercase |
| Meta | 11–12px | 400 | — |

### Layout
Content max-width 1360–1500px depending on screen. Standard page padding `28px`. The
common shape is a two-column grid — `minmax(0, 1fr)` main plus a `400–452px`
`position: sticky` aside at `top: 22px`.

## The screens

Twelve files. `Rostr Mobile.dc.html` is the mobile set; the other eleven are desktop.

Each file stacks its states vertically. Open it in a browser; the file is the spec for
pixel detail, and what follows is the intent and the decisions worth preserving.

### 1. `Rostr Landing.dc.html` — marketing landing, 2 hero variants
Five bands: sticky header, a full-width hero, the **section explorer**, a closing CTA on the
one saturated ground, footer. Copy is lifted verbatim from the repo README.

**The page was restructured at the user's request: five scrolling sections became one
explorer.** Inside a league, How it works, Why it's different, Format and Multi-sport used to
be five bands the visitor scrolled past; they are now seven panels behind a left rail, in one
band below the hero. The rail is a vertical list of labels with the active one carrying an
accent left border and a 10% tint; only the active panel is in the DOM (`sc-if` per panel),
and a `min-height: 620px` on the panel column keeps the page from jumping as you switch.

Three decisions inside that worth keeping:

**It went below the hero, not inside it.** The original ask was to put the explorer in the
hero's right column. That column is about 470×420px — the Format table alone is nine rows, so
each panel would have collapsed to a headline or the hero would have grown until the H1 left
the screen. The band below has room for the table at full size and the rail keeps all seven
labels visible at once, which a carousel does not.

**The rail is ordered as a season, not as a menu.** Why it's different, How it works, Format,
The draft, Inside a league, Playoffs and payout, Beyond football. The argument comes first
because it is the reason to keep reading; then the mechanics run in the order a manager meets
them, so the draft sits fourth rather than last.

**Nothing auto-advances.** Panels change only on click.

**The hero throw.** A football crosses the hero and its flight path resolves into the
accent rule under the headline. The visible path is the **partial Bézier up to the ball's
position** via one de Casteljau split, which is what makes the rule appear drawn *by* the
throw rather than sitting under it. On landing, a 520ms tween eases the six path numbers
from the flight curve to the resting line, measured from `underlineRef.offsetTop + 0.5`
— not a fraction of hero height, which drifts every time the h1 rewraps.

Two variants sit behind an on-page switcher: **A** is 950ms, linear, resolving to a 470px
underline; **B** is 1450ms, decelerating, arcing above the hero and resolving into the
full-width rule that closes it. **Pick one, delete the other and the switcher.**

Two SVG traps worth knowing: the resting path must keep a **non-zero bounding-box height**
(it ends 0.5px below where it starts) because SVG will not paint an `objectBoundingBox`
gradient on a zero-area box; and the gradient must stay on default `objectBoundingBox`
units with stops `0% α0 → 18% α0.9 → 82% α0.9 → 100% α0`, so the rule fades at both ends
at any length. Authoring `userSpaceOnUse` with px coordinates fails, because React
reasserts the literal attributes on every render.

**Production behaviour not in the prototype:** run the throw **once per visitor**, gated on
`localStorage`, and skip to the settled state on repeat visits. It replays every load here
because it is a review artifact.

**Panel 04 carries a condensed live draft board**, and it is built from the shipped
component rather than invented — read `DraftRoom.tsx`'s `BoardSquare` and `lib/player.ts`
before touching it. It reproduces four things exactly: cells are filled **by position** from
`POSITION_COLOURS` (QB rose, RB emerald, WR sky, TE amber, K violet, DEF teal, each at 0.15
alpha with a 0.3 ring), team names head the columns with a `you`/`bot` tag under them, each
row carries a **direction arrow** because the snake reversal is the one thing people get
wrong planning two picks ahead, and columns hold `min-w-[7.5rem]` — 120px. Three of twelve
teams are shown at full width rather than twelve squeezed: below 120px `shortName`'s
surnames truncate, which defeats the reason the given name is initialled in the first place.

Three things about it to keep. The crop fade is a **fixed-length** gradient
(`calc(100% - 88px)`), not a percentage — the panel doubles in width when the layout stacks,
and a percentage fade eats a whole visible column at the wider size. The on-clock card's
portrait is a 96px `<image-slot>`, matching the size `PlayerAvatar` documents for a card
portrait; at 52px the component's own empty state overflows its host. Real headshots come
from the provider's `imageUrl` through `sizedImage`, so in production most cells carry a
face and the initialled disc is the one-in-ten fallback — the design shows a placeholder
because no photo assets exist here.

And the **120px column floor has to be enforced in CSS, not assumed.** Written as
`minmax(0, 1fr)` the three columns collapsed to 56px between roughly 981px and 1105px of
viewport, clipping all seven player names to 15px of a 42–68px string — every name in the
board unreadable, in a window a laptop actually sits in. It is now `minmax(120px, 1fr)`, and
the panel's inner grid stacks at 1240px so the floor never has to fight a 300px aside.

**Cell colour on this board is position identity, not positional need.** The caption said
need for one revision and the cells never behaved that way — need-colouring belongs to
`Rostr Draft Room.dc.html`, where it is recomputed after each of your own picks. On a
three-column marketing board there is no room to explain a colour that means something else.

**The nav is four items:** How it works, a GitHub and an X icon, Create a league, and
Connect wallet. `#explore` is the one content anchor, since the explorer absorbed the three
tabs that used to point at separate sections. The X icon points at
`https://x.com/rostr_app`. Connect wallet is a `<button>`, not an anchor — connecting is an
action, and it is a **fourth surface needing the wallet signing round-trip** (see the list at
the end).

**This screen's player names are real; the other eleven screens' are not.** The landing
board and its league-home panel now name actual NFL players in ADP order — J. Jefferson,
B. Robinson and S. Barkley at 1.03–1.05, B. Bowers, N. Collins and T. McBride in round 2,
J. Allen at 3.03, and James Cook as the queue leader at 3.04. Board cells keep `shortName`'s
initialled form so they hold the 120px floor; the on-clock card has room for the full name.
Two caveats: **the ordering is a designer's guess at 2026 ADP, not data** — reconcile it
against the live Tank01 board, which the repo has no fixture for — and Route 66's five
starters in panel 05 were rewritten to match what the board shows them drafting, so those two
places have to move together.

### 2. `Rostr Create League.dc.html` — 2 states
**The finding that shaped this screen: only ten values are the commissioner's.** Scoring
is set by the project owner, the pot token is set by the service per network, and roster,
season, playoffs, tiebreakers, waivers, veto threshold and the 1% fee are all fixed. So
the page is mostly **disclosure, not configuration** — a short settings column, then a
"Not yours to set" section that states the rest plainly.

The ten: league name, visibility, draft date/time, pace, pick clock, bot, trade deadline
week, autofill ranking, pot on/off, buy-in, payout shape. (Twelve entries, two of which
only exist when the pot is on.)

State 2 is the freeze: a 880px dialog holding the entire rule set in a scroller, an
**unchecked** acknowledgement checkbox, and "Freeze and sign" starting `disabled`. That
control must never ship pre-checked — the screen's whole thesis is that consent is
deliberate.

Section 05 shows the pot unavailable, because the escrow program is unwritten. Note the
validation the rules require and this screen only partly shows: **pot + bot is refused
outright**, a draft time outside the creation window is refused, and a deadline outside
Weeks 8–14 is refused.

### 3. `Rostr Invite and Join.dc.html` — 2 states
The commissioner's side (invite link, email invites, the twelve-seat field with three row
states — joined, invitation out, open) and the invited manager's side, which is the more
important half: the full rule set, an itemised "what you are signing", the wallets already
in, and an unchecked acknowledgement gating "Sign and join".

Invitation rows carry real `<button>` actions (Resend, Withdraw) in their own column —
never a styled span, and never sharing a column with wallet hashes.

### 4. `Rostr Draft Lobby.dc.html` — 2 states
**The best screen in the set for demonstrating the product's argument.** Before the draw:
a 76px countdown and the plain statement that the order does not exist yet, with the
reason spelled out — if the seed were fixed in advance a commissioner could add a bot,
compute the order, remove it, and re-roll in private until it suited them.

After: the drawn order, and a verification panel giving slot, blockhash, block time, the
previous block's time (which is what makes it *the only block the league could have used*)
and the seed recipe, so anyone can recompute it on an explorer.

### 5. `Rostr Draft Room.dc.html` — 7 states
Order train, clock, player pool, queue/roster rail, full board. Built on ESPN's
conventions deliberately — managers arrive with them in muscle memory. Three departures:

1. **The autopick target is named, not implied** — the queue leader is promoted into its
   own card with a "Draft A. Villanueva" button.
2. **Accent means positional need, not position identity.**
3. **Chain facts sit where they are load-bearing, quietly** — block height on the train,
   rule hash under the draft button. Muted text, once each, not badges.

States 1–4: you on the clock (3.04, 47s) · someone else on the clock (3.07; you pick 4.09,
thirteen away — Draft and Queue invert, need moves RB→WR) · pick submitted waiting on the
wallet (a dialog itemising what is signed, and the clock **does not pause**; the board
cell reads "3.04 · signing") · autopick acted while you were away.

States 5–7 are the failure and ending branches:

**5 · Connection lost while you are on the clock.** No pause button, and the countdown is
labelled an estimate running locally from the last server message. Pausing on disconnect
would let anyone buy thinking time by closing a laptop, and no commissioner can adjudicate
whose outage was real. So the screen spends its space naming *exactly which player autopick
will take* rather than reporting an error, and says queue edits are stored locally and sent
on reconnect.

**6 · The pick failed and the clock ran out during it.** The branch state 3 does not cover,
and the only state where a manager loses the player they chose. A wallet prompt can outlive
the blockhash it signed against, so the transaction expires, the automatic rebuild lands
after 0:00, and autopick has already fired. The timeline runs 0:06 → +0:02 and ends on the
program rejecting the rebuild with `PickSlotFilled`. Note the fee detail: the expired
attempt costs nothing, the program-level rejection pays the base fee.

**This state is mostly reachable because of the signing round-trip, and pre-signing or a
session key would remove it** — the same decision autopick already forces. Settle it once,
for both.

**7 · Draft complete.** The screen stops being a draft room and becomes a handover: full
14-player roster with pick numbers and ADP, what happens before Week 1, the draft's on-chain
record, and a note that the two autopicks are shown with the same weight as every other pick
because an autopick is a real pick.

The clock panel is `flex: 0 0 320px` — **not a round number.** Its meta column carries
which pick is live and when you pick next; below that width "You pick 4.09" breaks into
three fragments. The three spans carry `white-space: nowrap`.

**Open architectural decision:** autopick must sign a transaction the manager was not
present for. Session key, pre-authorization at draft start, or a delegated signer — decide
this before the escrow program is written. The notice strip reads "signed 0x7f3a…c19d"
without claiming a mechanism; **do not ship that line until the mechanism is real.**

### 6. `Rostr League Home.dc.html` — 2 states
League home (your matchup, your starters, the league scoreboard, activity, standings,
waiver priority) and the full matchup, slot against slot with both benches.

Both carry the honest line about provisional scores: a week finalises 48 hours after its
last game because the NFL issues corrections for up to seven days, and weeks that pay out
wait the full seven.

Standings must be **computed**, and a team mid-game carries a shorter record than a team
whose week is final. Getting this wrong here inverted the playoff cut line.

### 7. `Rostr Lineup.dc.html` — 2 states
Setting the lineup with a player picked up — three slots lit (both WR and FLEX), the rest
labelled not eligible — and the lineup partially locked, where seven slots are gone, one
is empty, and autofill **names who it will start and when**, with the reason the
alternative was passed over.

The teaching point the copy carries: nobody forfeits anything for not showing up. No
abandonment rule, no strikes, no forfeiture — an empty slot simply gets filled, and turning
autofill off is the only way to score nothing there.

### 8. `Rostr Waivers.dc.html` — 2 states
Filing blind claims Tuesday night, and the Wednesday 3am run. The two player states are
visually distinct: **on waivers** (accent, "Claim") versus **free agent** (neutral, "Add
now"), and only players on waivers appear in the run.

The state 2 result is built to teach three rules at once: priority settles every contest
with another manager; **a failed claim costs nothing**; and your own filing order only
decides which of *your* claims gets your last roster spot. Claims 1 and 3 both need the
same roster spot, claim 1 loses to priority 3, and claim 3 therefore wins — file the
player you want most first. Winning two claims in one run moves priority **once**.

### 9. `Rostr Trade Veto.dc.html` — 4 states
The screen no other fantasy platform has. A one-for-two trade in escrow, its 48-hour
window, and the ten uninvolved managers' votes — two against, four needed. Then the
settled state: the threshold was not met, so the contract executed, with a full on-chain
record from proposal to atomic swap.

Not voting counts as allowing. Votes are signed messages and visible to the league,
because a secret ballot cannot be audited. **The commissioner has no override, and neither
does rostr.**

States 3 and 4 are the two halves of the step before it, set in Week 10 — a later trade in
the same league, one week before its deadline. **3 · Proposing:** the builder, plus the four
checks the rules require (both sides must give something, because a gift is how an eliminated
team hands its roster to a friend; rosters may change size, since limits are a lineup concern;
no player already committed elsewhere; and it must still be able to execute in time). No
trade grade is shown — a grade is an opinion dressed as arithmetic. **4 · The counterparty's
view,** because accepting is the consequential act: it signs, escrows all three players,
freezes them, and cannot be taken back.

The timing rule is the one worth implementing carefully: **the deadline binds on the week a
trade executes, not the week it was proposed.** With a Week 11 deadline ending Mon 23 Nov, the
last moment anything can be proposed is Sat 21 Nov, 11:30 PM. A trade accepted later
`EXPIRED`s untouched rather than executing.

### 10. `Rostr Playoffs.dc.html` — 2 states
Championship Sunday with the last two games live, then settled. The ladder is three columns
— Week 15 quarterfinals with seeds 1–2 on a bye, Week 16 semifinals, Week 17 championship
and third place — plus the six-team consolation bracket, which needs three rounds and so
uses all three playoff weeks.

The aside earns its place: **every round reseeds, so the bracket cannot be drawn in
advance.** Audibles upsetting the 4 seed changed who the *1 seed* played, not Route 66's
opponent — seed 3 draws seed 2 either way. That panel was factually wrong on first write;
reseeding arithmetic is genuinely easy to get backwards.

The settled state is the product's whole argument in one screen: a four-step derivation
anyone can re-run, the finalisation record (both providers agreeing, T+48h because this
league has no pot — a paying week holds seven days), and the on-chain trail from frozen
rules to derived champion. The `potLeague` prop adds the 70/20/10 payout and the 1% fee.

Route 66 wins as the 3 seed, 132.8–128.1, and the Week 17 starter total adds to exactly
that.

### 11. `Rostr Mobile.dc.html` — 10 screens at 390px
Landing, league home, lineup, draft room, join, the wallet signing sheet, waivers, the
Wednesday waiver run, an incoming trade, and the veto vote — each in a browser frame with a
620px viewport.

The veto frame gives the countdown its own top band, because the window is the only thing on
the screen that can expire; and "Allow it" is the ghost button since allowing needs no
signature, while voting against costs a transaction. The rationale for every departure from desktop is
written underneath the frames.

The two decisions worth keeping: **the draft board becomes a tab**, because twelve columns
will not fit at any legible size and a 90-second clock leaves no time to read a shrunken
one — so the clock, the positional-need line and one-tap draft own the screen. And **no
drag-and-drop anywhere**, because dragging a row inside a scrolling page is unreliable on
touch; tap a slot, choose from a sheet.

The join screen leads with what is being signed and states the negative explicitly — no
deposit, no approval, no spend permission. A crypto link from a friend, opened on a phone,
is exactly where people expect to be drained.

Two mechanical notes for implementation. Every tap target is ≥44px; eight buttons and two
links were under it on first write. And the acknowledgement gate needs
`disabled="disabled"` — a bare `disabled` attribute compiles to `disabled=""`, which React
drops, so the gate rendered as a live full-opacity button next to an unchecked box.

### 12. `Rostr Amend and Dissolve.dc.html` — 4 states
The last thing `RULES.md` defines and the only post-creation change permitted. Both amend
and dissolve need **unanimous signed consent of every stake-holding manager**; a bot seat
neither signs nor blocks.

**1 · Proposing an amendment** — a Week 11 → Week 13 trade-deadline change, with the diff,
the author's stated reason shown to everyone before they sign, and what an amendment cannot
do: touch league state (results, rosters, standings, waiver order, trade history), apply
retroactively, or be pushed through by the commissioner.

**2 · Nine of twelve, and stuck.** The design decision here is the absence of a progress
bar: nine of twelve is not three quarters of the way to anything, it is the same as zero
until it is twelve. There is no clock and no penalty for ignoring a proposal, silence never
becomes consent, and the three outstanding managers happen to be the two teams the change
would hurt. The screen shows who has not signed and does not editorialise.

**3 · Dissolving.** The copy is specific about what is lost — season stops, no champion,
rosters keep their NFTs with the transfer restriction relaxed as at settlement, ten weeks of
results stay on chain, and in a pot league every stake returns in full with no fee. The
aside shows *your own* standing (3rd, inside the playoff cut) next to an irreversible
decision, deliberately. Unanimity is what stops a losing half ending a season the winning
half is enjoying.

**4 · Auto-dissolved.** A different, pot-bearing league that never reached two humans by its
draft time, refunding 25.00 USDC in full. **The only screen in the set where money actually
moves** — worth reading for the fee rule (the 1% is charged at settlement, and this never
settled) and because auto-dissolve is why a deposit can never be permanently stuck. It is
also a first-run failure: someone created a league, invited seven people, and nobody came.
The copy points at the number that matters, six opened and none finished, rather than the
seven emails sent.

## One convention still to decide

**When does a week label flip?** These screens label Tuesday 17 November as "Week 10",
though Week 10's games all finished on the Monday and Week 11's do not start until Thursday.
Most fantasy platforms would call that period Week 11. No arithmetic in the designs depends
on it — the deadline math, the veto windows and the standings all hold either way — but the
implementation needs one rule for the boundary, and as authored the set implies Tuesday
belongs to the week just ended. Pin it down before the waiver run and the trade deadline are
both reading "current week" from it.

## States not designed

Ask before implementing any of these; they need design.

**Season:** player detail · full standings.

**One question the rules do not answer:** can escrow release move a player whose game is
already in progress? A trade accepted late on a Tuesday has its 48-hour window close on
Thursday evening, which is when Week 11 kicks off. The designs avoid the collision by
timestamp rather than by rule.

**Mobile:** create league, the commissioner's invite side, draft lobby, amend and dissolve,
and the playoff bracket.

A note on porting: the mobile waiver run was first written from the *rule* rather than from
the published desktop screen, and contradicted it on four facts — who won, which claim
illustrated the uncontested rule, the priority number, and which manager took the contested
player. Derive the demo league once and render both layouts from it.

**League lifecycle:** amend and dissolve, both unanimous signed consent, plus auto-dissolve
with refunds if the league never fills. `RULES.md` defines them; nothing is drawn.

**Everywhere:** the wallet signing round-trip has three designs (draft room state 3, its
failure branch in state 6, and the mobile sheet) and **four** other places that need it —
freezing a league, voting, any pot action, and the landing page's Connect wallet button.

## Files

- `screens/*.dc.html` — the twelve designs, plus `Rostr Screens.dc.html` (an index of them
  all with per-screen notes and the open questions) and `Rostr Logo.dc.html` (the logo
  exploration sheet). Open any directly in a browser.
- `brand/` — the finished logo, headers and X headers as PNG and SVG, with their own
  `README.md`. Social and print only; the product UI keeps its own header.
- `screens/support.js` — prototyping runtime. **Not for production.**
- `nocturne/styles.css` — token sheet and component layer (`.btn`, `.card`, `.tag`,
  `.table`, `.input`, `.field`, `.seg`, `.radio`, `.dialog`).
