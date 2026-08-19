# Design handoff — provenance and implementation status

`README.md` and `PULL_REQUEST.md` in this directory are the designer's own, kept
verbatim. This file is the repo's side: where these came from, what has been
built, and the one rule that matters when using them.

## Provenance

Drop 5 landed 2026-08-16; **drop 6 landed 2026-08-19** and is what is here now.
Earlier drops are **superseded entirely** — they were revisions of the same
screens, not different content:

| Drop | Contents |
| --- | --- |
| 1 | draft room only, early (44 KB) |
| 2, 3 | draft room revised (186 KB) |
| 4 | ten screens, plus mobile and playoffs |
| 5 | all twelve, plus amend-and-dissolve |
| **6** | **landing hero rebuilt, nav consolidated, mobile expanded, plus a screens index** |

If an older drop resurfaces, it is not a source of anything. Nothing in 1–5 is
absent from this directory.

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

**This is the trap in this directory right now.** `screens/Rostr Landing.dc.html`
still contains the roster-as-NFT claim, in two places, and the app deliberately
does not. Anyone implementing that hero from the design will paste a false
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
