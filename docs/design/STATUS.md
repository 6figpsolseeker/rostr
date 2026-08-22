# Design handoff — provenance and implementation status

`README.md` and `PULL_REQUEST.md` in this directory are the designer's own, kept
verbatim. This file is the repo's side: where these came from, what has been
built, and the one rule that matters when using them.

## Provenance

Drop 5 landed 2026-08-16, drop 6 on 2026-08-19, drop 7 earlier on 2026-08-21;
**drop 8 landed 2026-08-21** and is what is here now.
Earlier drops are **superseded entirely** — they were revisions of the same
screens, not different content:

| Drop | Contents |
| --- | --- |
| 1 | draft room only, early (44 KB) |
| 2, 3 | draft room revised (186 KB) |
| 4 | ten screens, plus mobile and playoffs |
| 5 | all twelve, plus amend-and-dissolve |
| 6 | landing hero rebuilt, nav consolidated, mobile expanded, plus a screens index |
| 7 | the landing becomes a section explorer; real NFL names; a brand kit; a logo sheet |
| **8** | **the Leagues hub — one screen for your leagues, invitations and browsing** |

If an older drop resurfaces, it is not a source of anything. Nothing in 1–7 is
absent from this directory.

### What drop 8 changed

**One file: `screens/Rostr Leagues.dc.html`.** Every other screen and the whole
brand kit are byte-identical to drop 7.

It proposes replacing **three shipped surfaces with one**. Today the shell
carries "Join a league", a "Create a league" button and `InvitationBadge` side
by side; `/leagues` browses public leagues with `InvitationsCorner` beside it;
and `/invitations` is a third page. The design is a single `Leagues` nav item
ordered **your leagues → invitations → public leagues**, with create as a card in
the page head.

The gap it names is real and ours: **nothing on `/leagues` lists the leagues you
are already in**, which is the first thing a returning manager wants. This repo
has known that since the commissioner's checklist landed — "there is no 'my
leagues' list to find it in again".

**The designer read the shipped code**, which is worth knowing when reconciling:
`InvitationBadge` and `INVITATIONS_KEY`, the deduplicated count that renders
nothing at zero, `LeagueBrowser`'s PUBLIC-and-FORMING filter, seats against
`maxTeams`, the buy-in computed by string surgery rather than floating point.
Those parts are described as **grounded — recreate from source, not from these
pixels.**

**What is a proposal with no backing route:** the urgent strip, the bell, the
account menu, and the `Your leagues` section. Only the invitation count has a
real source today. Do not read the screen as a description of what exists.

#### State 4 exists to stop a regression, and it is right

Collapsing `SessionBar` into an avatar and a chevron would silently delete two
shipped affordances: the **Sign out** button, and the `username === null` branch
that renders **Finish setting up** linking to `/welcome`. The second matters more
than it looks — an account with no username cannot be invited to anything, and
since 2026-08-21 it cannot create or join a league either. Both are drawn into
the account menu. If that header is ever rebuilt, this is the thing to check.

#### Three rules the screen states, all of which the repo already enforces

- **No join control in a list.** Both card types lead to the league page, where
  the whole rule set renders above the join button. `RULES.md` requires the full
  document before anyone joins.
- **Private leagues never appear in the public list.** They arrive as an
  invitation or a link.
- **Every public league shows Free**, because no league can take a deposit until
  settlement is written. Dollar amounts would be designing a feature that does
  not exist.

Verified on install: the file contains no roster-as-NFT claim, no
"held in your wallet", and no join button in a list.

#### Two CSS traps recorded, and one applies to any Tailwind rebuild

An absolutely-positioned panel does not push a footer — the frame needs to be a
flex column with the footer on `margin-top: auto`. And **auto side margins on a
flex item suppress `align-self: stretch` and trigger shrink-to-fit**, which
collapsed two 1180px columns to content width. In Tailwind terms: `mx-auto` on a
flex child needs `w-full` beside it.

#### Three of the "still open" questions are already answered

Drop 8 repeats them, so the answers have not reached the designer. They should
go back in the next reply:

- **How autopick signs a transaction** — it does not. A pick is a database write
  and nothing on that path signs anything; see CLAUDE.md, "Drafting signs
  nothing". Draft room state 6 is designed for a failure that cannot happen.
- **Which hero animation** — **A**, decided 2026-08-21.
- **Kickoff** — the **9th**, confirmed against the synced schedule and by the
  owner. The designs still say the 10th.

Still genuinely open: when a week label flips, and whether escrow release can
move a player whose game is in progress.

### What drop 7 changed

**The landing page is redesigned again, and it supersedes what was built from
drop 6 on 2026-08-19.** Five scrolling bands — How it works, Why it's different,
Format, Multi-sport — become **seven panels behind a left rail** in one band
below the hero, and the hero goes back to **full-width text**. So the hero draft
board that `LandingDraftBoard.tsx` renders beside the headline is, in drop 7, a
panel inside the explorer instead.

The rail is ordered as a season rather than as a menu: why it's different, how it
works, format, the draft, inside a league, playoffs and payout, beyond football.
The designer records why a rail beat a carousel — all seven labels stay visible,
where a carousel would put the four differentiators behind two clicks — and why
the explorer sits below the hero rather than inside its right column, which is
470×420 and cannot hold a nine-row table.

**What is already built and still correct:** the consolidated nav (one How it
works link, GitHub and X as icons, Create a league, Connect wallet) is unchanged
by drop 7, as is the board's own construction.

**Real NFL names, with two caveats the designer states plainly.** The landing
board now names actual players in ADP order. The ordering is *a designer's guess
at 2026 ADP, not data*, and Route 66's five starters in panel 05 were rewritten
to match what the board drafts — **those two places have to move together or the
demo contradicts itself.** The other eleven screens still carry invented names.

**A bot rule was corrected.** `Rostr Amend and Dissolve.dc.html` said "Bots fill
any empty seat"; it now says one bot, only to square an odd field, never in a
league with a pot — which is what `addBot` enforces.

**New: `brand/`** — 22 logo, header and X-header assets, PNG and SVG, with their
own README, and `screens/Rostr Logo.dc.html`. The designer's rule: **social and
print only; the product UI keeps its own header.** Nothing in `apps/web` should
import from here.

#### Three defects the designer caught, worth reading before building the landing

Each shipped in a revision of that screen and was found by review rather than by
writing it. All three are the same shape as defects this repo has had:

- **`minmax(0, 1fr)` is not a floor.** The board collapsed to 56px columns
  between roughly 981px and 1105px of viewport, clipping every player name — in a
  window a laptop actually sits in. The shipped component pins `min-w-[7.5rem]`,
  which is what `LandingDraftBoard` already uses; the design now writes
  `minmax(120px, 1fr)` and stacks its inner grid at 1240px.
- **A caption claimed a rule the markup did not follow** — it said colour tracked
  positional need while the cells were strict position identity. Need-colouring
  belongs to the draft room, where it is recomputed after each of your picks.
  This is exactly the "comment asserting a guarantee the code does not provide"
  class `CLAUDE.md` names.
- **Reseeding arithmetic goes backwards easily**, and this panel has now been
  wrong on first write twice. The canonical bracket lives in
  `Rostr Playoffs.dc.html`.

#### Three of drop 7's open questions are now answered

The designer lists five things "needing you rather than a developer". Three
have answers as of 2026-08-21 and should go back in the next reply:

- **How autopick signs a transaction the manager was not present for** —
  it does not. A pick is a database write; nothing on that path signs
  anything. The question came from the roster-as-NFT design, which is
  abandoned. **Draft room state 6 is designed for a failure that cannot
  happen** — a wallet prompt outliving its blockhash during a pick — and can
  be dropped. See CLAUDE.md, "Drafting signs nothing".
- **Which hero animation ships** — **A**.
- **Kickoff** — the 9th. See below.

Still open and genuinely for the owner: when a week label flips, and whether
escrow release can move a player whose game is in progress.

#### The kickoff question is settled, and the designer's guess is wrong

Drop 7 asks whether kickoff is 9 or 10 September, notes that all twelve designs
say the 10th while `README.md` says the 9th, and concludes the README is wrong
because "9 Sept 2026 is a Wednesday and NFL Week 1 opens Thursday".

**Checked against the synced 2026 schedule on 2026-08-21. The README is right.**
The first Week 1 game in the database is `20260909_NE@SEA`, kicking off
**Wednesday 9 September 2026, 8:20 PM ET**. The 10th is also a Week 1 date —
`20260910_SF@LAR`, Thursday 8:35 PM — so the designs are not absurd, they are
naming the second game.

The reasoning was a general rule about the NFL calendar applied to a season that
does not follow it. **Confirmed by the owner on 2026-08-21: it is the 9th.** **Do not "fix" the README to match the designs**, and tell
the designer before the next drop propagates the 10th any further. Verified with
one provider, which is the same provider `docs/TANK01.md` warns is an ESPN
re-serialisation — but the game id encodes the date independently of the kickoff
timestamp, and both say the 9th.

### What drop 6 changed

Four files, and only one of them is a redesign:

- **`Rostr Landing.dc.html`** — the hero gained a right column: a condensed live
  draft board. It is **built from the shipped component rather than invented**,
  which is worth knowing before touching it. The designer read `DraftRoom.tsx`'s
  `BoardSquare` and `lib/player.ts` and reproduced `POSITION_COLOURS` at their
  real alpha, the `you`/`bot` column tags, the per-row direction arrow, and the
  `min-w-[7.5rem]` column floor — showing three of twelve teams at full width
  rather than twelve squeezed, because below 120px `shortName`'s surnames
  truncate and the initialled given name stops buying anything. The README
  records both traps: the crop fade is a fixed length rather than a percentage,
  and the on-clock portrait is 96px because that is the size `PlayerAvatar`
  documents for a card.
- **`Rostr Mobile.dc.html`** — 89 KB to 143 KB, now seventeen frames at 390px.
  Still not started, and still a different design rather than a reflow.
- **`Rostr Create League.dc.html`** — one row. See the section below; this is the
  divergence closing rather than a new one opening.
- **New: `Rostr Screens.dc.html`** (an index of every screen and its states) and
  **`screens/image-slot.js`** (a second prototyping runtime, for the photo
  placeholders in the new hero). `image-slot.js` falls under the same rule as
  `support.js` below — **neither ever ships**.

**The nav is now four items** — How it works, GitHub, X, Create a league, Connect
wallet — with the three separate How-it-works tabs consolidated into one anchor
at the owner's request. **Connect wallet is a `<button>`, not a link**, which
makes it a fourth surface needing the wallet signing round-trip alongside
freezing a league, voting, and pot actions.

One line inside `Rostr Screens.dc.html` still reads "drop 5 at docs/design/". It
is wrong as of this drop and is left alone: these files are the designer's
artifacts, kept verbatim, and this file is where the repo states provenance.

## The rule

**`screens/support.js` and `screens/image-slot.js` must never ship.** They are
prototyping runtimes the `.dc.html` files need to render in a browser, and
nothing in `apps/web` may import either. They live under `docs/` rather than
anywhere Next can reach, which is what keeps that true structurally rather than
by memory. `image-slot.js` arrived with drop 6 and is the larger of the two — it
draws the photo placeholders in the new hero, and the real app draws those from
the provider's `imageUrl` through `sizedImage`.

The `.dc.html` files are a **reference for look, layout and copy** — not code to
lift. Recreate them with the patterns `apps/web` already uses. Take the exact
values and the copy from here; express them the way this repo expresses things.

Both files are in `.prettierignore`: they are generated artifacts, and
reformatting them would make the diff against the next drop unreadable.

## What is built

| Screen | Status |
| --- | --- |
| Landing | **Built** — PR #150. Nocturne tokens added to `globals.css` alongside the existing `field`/`chalk`/`turf` palette rather than replacing it. |
| Amend and Dissolve | Not built. There is no dissolve anywhere in the product — see #163, and #137 for the automatic case. |
| Create League | Partly — the screen exists and predates this design. |
| Invite and Join | Partly — same. |
| Draft Lobby, Draft Room | Not built to this design. `DraftRoom.tsx` is 778 lines of working code on the old look. |
| League Home, Lineup, Waivers, Trade Veto, Playoffs | Not built to this design; working screens exist. |
| Mobile | Not built. Six screens at 390px, and it is a different design rather than a reflow — bottom nav, the draft board becomes a tab, no drag-and-drop, tables cut to three columns. |

The application palette is still `field`/`chalk`/`turf` everywhere except the
landing page. Moving the rest to Nocturne is a redesign of every screen, and
`globals.css` says which set gets deleted when that happens.

## Read the README's "before you build anything" section

It is the most valuable part of the handoff and it is not about visuals. Nine of
the twelve defects found while designing these screens were **the same fact
authored twice** — a 6-team lobby feeding a 12-team draft room, a roster limit of
15 on one screen and 14 on the next, a 48-hour veto window whose timestamps
spanned 77 hours.

That table of "derive these, never restate them" is a specification for the
implementation, not a note about the prototype. Several of its entries are
invariants this repo already enforces — the bracket recomputed rather than
stored, the veto denominator counting managers rather than teams, per-player
kickoff locks rather than a league-wide deadline — and a screen that restates
one of them will drift from the code that owns it.

## Do not build drop 6's landing copy — two sentences are retired

**This is the trap in this directory right now. Drop 7 did not fix it and drop 8
did not touch the file — both checked on 2026-08-21.** `screens/Rostr Landing.dc.html` still contains the
roster-as-NFT claim, in two places, and the app deliberately does not. Anyone implementing that hero from the design will paste a false
sentence back onto the front page, which is precisely how it got there the first
time.

The design says:

> Drafted players are held in your wallet, not on a platform's server.

and, on a card lower down:

> Drafted players mint as Token-2022 NFTs held in your wallet.

**Both are untrue and were removed from `apps/web` on 2026-08-19.** Rosters are
rows in Postgres. Nothing has ever minted an NFT, there is no NFT program, and
the roster-as-NFT design is abandoned rather than pending. `page.tsx` carries a
comment at each site saying so and asking that no NFT sentence be restored until
something actually mints one.

What replaced it is a claim that holds and is checkable in the source: no
commissioner can edit a team, force a trade, or overrule a result, because there
is no such function to call.

The design files stay verbatim — they are the designer's artifacts and this file
is where the repo records divergence. **The divergence is in the app, and it is
deliberate.** If a future drop drops these sentences, this section goes with it.

Note that `CLAUDE.md`'s settled-decisions table still lists "NFTs _are_ the
roster, not souvenirs" as **Settled**, which is the same stale claim wearing a
different hat. It is not this file's to fix, but do not read it as current.

## Changed from the designer's original

Beyond the copy above: **nothing in the files.** The paragraph that used to sit
here is worth keeping as a record of how that came to be true.

Drop 5's `Rostr Create League.dc.html` printed the scoring table this repo used
until 2026-08-16 — a shutout worth 10, field goals stopping at 50+, no penalty
for a miss, no yards-allowed ladder — because it was drawn before the ESPN
alignment. Those numbers were already wrong when the handoff arrived, and the
freeze screen is precisely where a member reads the rules before signing them, so
the values were corrected here and `design-scoring.test.ts` was written to pin
the two together.

**Drop 6 fixes it at the source**, crediting that test by name, and goes one
further: the table now also prints the extra point, which the rule set has always
paid and the design had no row for. The guard gained a case for it in the same
commit that installed the drop — a value the design states is a value that can go
stale, and the lag between "the design started saying it" and "the test started
checking it" is exactly what let the whole table drift for a day.

The test still earns its keep for the next drop rather than this one: if a future
drop lands carrying an old table, it fails, and the fix is to correct the file
and tell the designer, because the drop was authored against stale values.

**This does not make the screen safe to build from.** When the freeze screen is
implemented it must render from the rule set, the way `/scoring` already does.
The test guards the reference; only deriving guards the product.
