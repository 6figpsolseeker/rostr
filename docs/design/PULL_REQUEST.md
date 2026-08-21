Branch: `design/screens`

---

## Design drop 7 — the landing page consolidates into a section explorer

Twelve screen files plus an index and a logo sheet, covering rostr end to end: the public
landing page, creating and freezing a league, inviting and joining it, the draft lobby and
the order draw, the draft room and its failure branches, the weekly in-season loop including
the full trade flow, the playoffs and settlement, amending and dissolving a league, and ten
screens designed for mobile web.

Nothing here is wired into `apps/web`. `design_handoff/` is the reference to build against.

### What changed since drop 6

**Five scrolling sections became one explorer.** Inside a league, How it works, Why it's
different, Format and Multi-sport were five bands a visitor scrolled past. They are now seven
panels behind a left rail, in a single band below the hero, with the draft board and a new
playoffs panel joining them. The hero is full-width text again.

The rail is ordered as a season rather than as a menu: **Why it's different → How it works →
Format → The draft → Inside a league → Playoffs and payout → Beyond football.** The argument
leads because it is the reason to keep reading; the mechanics then run in the order a manager
meets them, which puts the draft fourth instead of last. Nothing auto-advances.

Two things about the placement worth recording, since they were the actual design question:

- The original ask was to put the explorer **inside the hero's right column**. That column is
  about 470×420px, and the Format table alone is nine rows — every panel would have collapsed
  to a headline, or the hero would have grown until the H1 left the screen. Below the hero,
  the table fits at full size.
- A rail beats a carousel here because **all seven labels stay visible**. In a carousel,
  panels 2–6 are the four differentiators — the whole argument — behind two clicks.

**Real NFL names on the landing page.** The board and its league-home panel now name actual
players in ADP order: J. Jefferson, B. Robinson, S. Barkley at 1.03–1.05; B. Bowers,
N. Collins, T. McBride in round 2; J. Allen at 3.03; James Cook as the queue leader at 3.04.
Board cells keep `shortName`'s initialled form so they hold the 120px column floor.

**Two caveats on that.** The ordering is a designer's guess at 2026 ADP, not data — the repo
has no ADP fixture, only Tank01 test files — so reconcile it against the live board.
And Route 66's five starters in panel 05 were rewritten to match what the board shows them
drafting; those two places have to move together or the demo contradicts itself. The other
eleven screens still carry invented names.

**The bot rule was wrong in one place.** `Rostr Amend and Dissolve.dc.html` said "Bots fill
any empty seat". Corrected: **one bot, only to square an odd field, never in a league with a
pot.** The other screens already stated it correctly; the landing page's Format table and
closing CTA now say it explicitly too.

**Brand assets are in `brand/`** — the logo, headers, X headers, PNG and SVG, with their own
README. Social and print only; the product UI keeps its own header.

### Three defects worth reading before you build the landing page

Each of these shipped in a revision of this screen and was caught by review, not by writing:

**A `minmax(0, 1fr)` column floor is not a floor.** The draft board collapsed to 56px columns
between roughly 981px and 1105px of viewport — every one of the seven player names clipped to
15px of a 42–68px string, unreadable, in a window a laptop actually sits in. The shipped
component pins `min-w-[7.5rem]`; the design now writes `minmax(120px, 1fr)` and stacks the
panel's inner grid at 1240px so the floor never fights a 300px aside.

**A caption can claim a rule the markup does not follow.** The board's caption said colour
tracked positional need; the cells were strict position identity the whole time, including
Route 66's own filled slots. Need-colouring belongs to the draft room, where it is recomputed
after each of your own picks.

**Reseeding arithmetic goes backwards easily.** The playoffs panel first showed seeds 3 and 6
both advancing out of a round where seeds 1 and 2 were byed — impossible under any pairing.
The canonical bracket in `Rostr Playoffs.dc.html` is: 3 beat 6 and 5 beat 4, reseed, then 1
draws 5 and 2 draws 3. This is the second time this exact panel has been wrong on first
write.

### Read the README's second section first

Most defects found while designing these were not visual. They were the same league described
inconsistently in two places. The README lists the twelve facts that must be **derived from
one source and never restated** — roster limit, standings order, veto threshold, veto
deadline, draft order, autofill target, positional need, lock state, season dates,
snake-pick arithmetic, bracket shape, unanimity denominator.

### Still open, and needing you rather than a developer

- **How autopick signs a transaction the manager was not present for.** Session key,
  pre-authorization at draft start, or a delegated signer. This also creates draft room
  state 6, where a manager loses the player they chose because a wallet prompt outlived its
  blockhash. Settle it before the escrow program is written.
- **Which hero animation ships, A or B.** Both are in the file behind a switcher.
- **Kickoff is 9 September in `README.md` and 10 September across all twelve designs.**
  9 Sept 2026 is a Wednesday and NFL Week 1 opens Thursday, so I believe the README is wrong.
- **When a week label flips.** The trade and amend screens label Tuesday 17 Nov as Week 10,
  after Week 10's games are finished and before Week 11's start.
- **Whether escrow release can move a player whose game is already in progress.**

### Not done

- Five desktop screens have no mobile design — create league, the commissioner's invite side,
  draft lobby, amend and dissolve — and neither does the playoff bracket.
- Player detail, full standings.
- The wallet signing round-trip is designed three times and needed in four more places:
  freezing a league, voting, any pot action, and the landing page's Connect wallet button.
- The wordmark has no vector version; the ball's SVG is exact but the letters are live Inter
  text. Needs a vector editor before print.
