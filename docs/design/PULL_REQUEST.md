Branch: `design/screens`

---

## Design drop 8 — the Leagues hub

Thirteen screen files plus an index and a logo sheet, covering rostr end to end: the public
landing page, the signed-in Leagues hub, creating and freezing a league, inviting and joining
it, the draft lobby and the order draw, the draft room and its failure branches, the weekly
in-season loop including the full trade flow, the playoffs and settlement, amending and
dissolving a league, and ten screens designed for mobile web.

Nothing here is wired into `apps/web`. `design_handoff/` is the reference to build against.

### What changed since drop 7

**One `Leagues` nav item replaces three surfaces.** The shell carried "Join a league", a
"Create a league" button and an `InvitationBadge` side by side; `/leagues` browsed public
leagues with an `InvitationsCorner` aside; `/invitations` was a third page. `Rostr
Leagues.dc.html` is one page ordered **your leagues → invitations → public leagues**, with
create given equal weight as a card in the page head.

The gap it closes: nothing on the old `/leagues` listed the leagues you are already in, which
is the first thing a returning manager wants.

**A notification model, in two parts.** An **urgent strip** under the header for anything on a
clock — on the clock, draft within the hour, veto window closing, lineup unset near kickoff,
waivers running, a trade awaiting your answer — one item at a time, the most pressing. And a
**bell** holding everything, including whatever is currently in the strip, so nothing lives
only in a place that disappears.

The reasoning worth keeping: a 90-second draft clock cannot live behind a click. If a manager
has to open a dropdown to learn their pick is live, the dropdown failed. The strip is empty
almost always, which is what makes it mean something when it is not.

Anything needing a **signature** — submitting a pick, voting on a trade — carries a wallet
mark, so "this will ask for your wallet" is visible before the click.

**State 4 exists to stop a regression.** Collapsing `SessionBar` into an avatar and a chevron
silently deletes two shipped affordances: the **Sign out** button, and the `username === null`
branch that renders **Finish setting up** linking to `/welcome`, because an account with no
username cannot be invited to anything. Both are drawn in the account menu.

### What is grounded, and what is a proposal

**Grounded** — recreate from source, not from these pixels:

- The header is `(app)/layout.tsx` verbatim except where noted: wordmark 19px/600/−0.02em plus
  the `FANTASY FOOTBALL` descriptor (11px/0.14em/neutral-600), `max-w-[1180px] px-10
  py-[14px]`, "How scoring works", and the footer on every signed-in page — *Pre-alpha. Not
  audited. Do not use with funds you cannot lose.*
- The invitation count is `InvitationBadge`: `INVITATIONS_KEY` = `/api/invitations`,
  deduplicated with the panel so the count and the list cannot disagree, rendering nothing at
  zero rather than a `0`.
- Browse cards are `LeagueBrowser`: PUBLIC and FORMING only, seats against `maxTeams`, draft
  time in the reader's timezone, buy-in from base units by string surgery (no floating point
  near money).

**Proposals with no backing route:** the urgent strip, the bell, the account menu, and the
`Your leagues` section. Only the invitation count has a real source today.

### Three rules this screen must not break

**No join control in a list.** Neither a browse card nor an invitation card offers one — both
lead to the league page, where the whole rule set renders above the join button. `RULES.md`
requires the full document before anyone joins, and a join button in a directory is a way to
agree to a rule set nobody read.

**Private leagues never appear in the public list.** They arrive only as an invitation or a
link.

**Every public league shows Free.** The escrow program is unwritten, so no league can take a
deposit. The buy-in filter is drawn for when that changes and the page says so; dollar amounts
would be designing a feature that does not exist.

Two smaller corrections from reading the source: the nav names only routes that exist — there
is no global `/players` or `/activity`, both are league-scoped — and invitation rows say
"addressed to your username", because `/api/invitations` returns `addressedAs: "USERNAME" |
"WALLET"`, which is how you were reached, not who sent it.

### Two CSS traps this screen hit

Both shipped broken here before review caught them, and both are the kind that look fine until
they don't:

**An absolutely-positioned panel does not push a footer.** The overlay frames flowed their
footer after only a short paragraph and landed it 400px above the panel's bottom edge. Fixed
by making the frame a flex column with the footer on `margin-top: auto`.

**Auto side margins on a flex item suppress `align-self: stretch` and trigger shrink-to-fit.**
That fix immediately collapsed two 1180px columns to content width and re-centred them. Hence
the explicit `width: 100%` beside every `max-width: 1180px; margin: 0 auto` inside a flex
frame. If you rebuild these in Tailwind, `mx-auto` on a flex child needs `w-full` with it.

### Still open, and needing you rather than a developer

- **How autopick signs a transaction the manager was not present for.** Session key,
  pre-authorization at draft start, or a delegated signer. Settle it before the escrow program
  is written.
- **Which hero animation ships, A or B.**
- **Kickoff is 9 September in `README.md` and 10 September across all designs.** 9 Sept 2026 is
  a Wednesday and NFL Week 1 opens Thursday.
- **When a week label flips** — Tuesday sits between two weeks and the screens call it the one
  just ended.
- **Whether escrow release can move a player whose game is already in progress.**

### Not done

- The Leagues hub has no mobile design. Five other desktop screens have none either — create
  league, the commissioner's invite side, draft lobby, amend and dissolve — nor does the
  playoff bracket.
- Player detail, full standings.
- The wallet signing round-trip is designed three times and needed in four more places.
- Player names are real on the landing page only; the other twelve screens carry invented
  ones, and the landing page's ADP ordering is a designer's guess — reconcile against the live
  Tank01 board.
- The wordmark has no vector version; needs a vector editor before print.
