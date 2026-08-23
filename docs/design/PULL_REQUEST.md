Branch: `design/screens`

---

## Design drop 9 — session and navigation in the header

Thirteen screen files plus an index and a logo sheet, covering rostr end to end: the public
landing page, the signed-in Leagues hub, creating and freezing a league, inviting and joining
it, the draft lobby and the order draw, the draft room and its failure branches, the weekly
in-season loop including the full trade flow, the playoffs and settlement, amending and
dissolving a league, and ten screens designed for mobile web.

Nothing here is wired into `apps/web`. `design_handoff/` is the reference to build against.

### What changed since drop 8

**"Create a league" is now "Leagues", everywhere on the landing page.** The user's reasoning:
not everyone arriving is starting a league — plenty are joining a friend's — so naming only
the create path is misleading. The nav button points at `/leagues`. Both page CTAs read **"Join
or create a league"**, and the closing headline is "joined, created, and drafted".

**The landing header has a connected state.** Disconnected shows *Connect wallet*. Connected
replaces that button in the same slot with the avatar and username, and adds a notification
bell to its left.

**Disconnecting is signing out.** The wallet is the account, so the menu carries one row —
*Disconnect wallet* — not a Disconnect and a Sign out doing the same thing. The Leagues page's
account menu now matches, and states in words that it returns you to the landing page: signing
out from any screen lands on `/`.

Three behaviours worth preserving when you build it:

- The username menu **opens on hover**, with the hover zone wrapping both button and menu and
  an 8px bridge between them, so travelling into the menu does not close it. It also opens on
  `focus` — hover alone is unreachable by keyboard.
- The bell **opens on click**. A hover-open bell fires by accident constantly. Opening either
  panel closes the other, so only one is ever up.
- The bell **exists only when connected**. An anonymous visitor has no notifications, and an
  empty bell on a marketing page is furniture.

The landing page opens disconnected, which is what a first-time visitor sees. The
`walletConnected` prop and the in-page buttons both flip it.

### One decision still open

**The two account menus disagree: the landing page's opens on hover, the app's on click.** You
were asked and left it blank, so both are in the file as built. Pick one before a developer
implements two behaviours for one control.

### A CSS trap worth reading, because it took three attempts

The overlay states (Leagues states 2 and 4) show a dropdown over the page. Built the obvious
way — `position: absolute` panel in a `position: relative` frame — the panel is out of flow and
**cannot push the footer**: the footer followed only the short dimmed paragraph and landed
400px above the panel's bottom.

Two fixes each broke something new. `margin-top: auto` on the footer made its position depend
on a **guessed `min-height`** — which cleared in one state and collided by 39px in the other,
and would re-break every time the menu gained a row. And auto side margins on a flex item
**suppress `align-self: stretch` and trigger shrink-to-fit**, silently collapsing two 1180px
columns to content width.

What is in the file now: each overlay frame is a `row-reverse` flex row holding the panel as a
real `flex: 0 0 392px` column and the dimmed page beside it, so whichever is taller pushes the
footer through ordinary flow — no `min-height`, nothing to re-tune. **In production the panel
really is absolutely positioned**; this structure exists only so a static review artifact can
show an open dropdown without the page beneath it lying about its height. Don't copy the row
into the app.

The lasting rule: **`mx-auto` on a flex child needs `w-full` with it.**

### Read the README's second section first

Most defects found while designing these were not visual — they were the same league described
inconsistently in two places. The README lists the twelve facts that must be **derived from one
source and never restated**: roster limit, standings order, veto threshold, veto deadline,
draft order, autofill target, positional need, lock state, season dates, snake-pick arithmetic,
bracket shape, unanimity denominator.

### Still open, and needing you rather than a developer

- **How autopick signs a transaction the manager was not present for.** Session key,
  pre-authorization at draft start, or a delegated signer. Settle it before the escrow program
  is written.
- **Which hero animation ships, A or B.** Both are in the file behind a switcher.
- **Kickoff is 9 September in `README.md` and 10 September across all designs.** 9 Sept 2026 is
  a Wednesday and NFL Week 1 opens Thursday.
- **When a week label flips** — Tuesday sits between two weeks and the screens call it the one
  just ended.
- **Whether escrow release can move a player whose game is already in progress.**
- **Hover or click for the account menu.**

### Not done

- The Leagues hub has no mobile design, and the landing page's connected header has no mobile
  design either. Five other desktop screens have none — create league, the commissioner's
  invite side, draft lobby, amend and dissolve — nor does the playoff bracket.
- The urgent strip and the bell have no route behind them; only the invitation count does
  (`/api/invitations`).
- Player detail, full standings.
- Player names are real on the landing page only; the other twelve screens carry invented
  ones, and the landing page's ADP ordering is a designer's guess — reconcile against the live
  Tank01 board.
- The wordmark has no vector version; needs a vector editor before print.
