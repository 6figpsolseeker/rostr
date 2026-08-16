# Design handoff — provenance and implementation status

`README.md` and `PULL_REQUEST.md` in this directory are the designer's own, kept
verbatim. This file is the repo's side: where these came from, what has been
built, and the one rule that matters when using them.

## Provenance

Added 2026-08-16 from the fifth and latest handoff drop. Four earlier drops
existed and are **superseded entirely** — they were revisions of the same
screens, not different content:

| Drop | Contents |
| --- | --- |
| 1 | draft room only, early (44 KB) |
| 2, 3 | draft room revised (186 KB) |
| 4 | ten screens, plus mobile and playoffs |
| **5** | **all twelve, plus amend-and-dissolve** |

If an older drop resurfaces, it is not a source of anything. Nothing in 1–4 is
absent from this directory.

## The rule

**`screens/support.js` must never ship.** It is a prototyping runtime the
`.dc.html` files need to render in a browser, and nothing in `apps/web` may
import it. It lives under `docs/` rather than anywhere Next can reach, which is
what keeps that true structurally rather than by memory.

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
