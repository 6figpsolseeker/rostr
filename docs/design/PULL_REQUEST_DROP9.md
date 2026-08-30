# Design drop 9 — mobile completed, landing made responsive, stale copy retired

Not for immediate merge — review pass pending.

## What changed

### screens/Rostr Mobile.dc.html — 17 frames become 34
Most shipped routes now have a 390px design, plus the edge states. Three do not:
`/scoring`, `/invitations` (folded into frame 18 as a section) and `/ops/stats`.
The bottom nav in these frames is `Home · Matchup · Team · Players · League`, which
does not match the shipped nav (`LeagueChrome.tsx`): `League` is a fifth tab with no
route, and `Trades` and `Standings` are shipped tabs missing from it — so frames 20,
31 and 34 are unreachable from the design's own navigation. Reconcile before building.
Routes are also written `/l/<slug>/…` throughout; shipped is `/leagues/[id]/…`.

New frames, in file order:

- 18 Leagues — the drop-8 hub stacked for a phone (your leagues → invitations → public;
  no join button in any list, every card leads to the rules)
- 19 Player detail — status decides the pinned action; a claim names its drop on the button
- 20 Full standings — twelve rows, three columns, PF on the second line, the cut line drawn
- 21 Matchup — slot against slot, the second line explains any missing number
- 22 Sign in — email code first, wallet second (a wallet signs only money and consent)
- 23 Finish setting up — the username gate, stated as what it unblocks
- 24 Draft board tab — one round at a time as twelve rows, pager at the thumb;
  strict position-identity tags (need-colouring stays on the Draft tab)
- 25 Pre-draft queue — 44px arrows, no drag; autopick fallback stated
- 26 Notifications — the desktop dropdown as a page; needs-you first with the
  do-nothing consequence
- 27 Account menu — bottom sheet carrying Sign out and the Finish-setting-up branch
  (the two affordances STATUS.md warns a header rebuild deletes)
- 28 League home, pre-draft — countdown, seat meter, the one useful action
- 29 Draft room, connection lost — server clock keeps running; queue covers you
- 30 Claim lost — who won on what priority, and what did not change
- 31 Trade composer — tap-to-toggle from both rosters; 48h veto stated before send
- 32 Team tab — bench + IR; Drop refuses with GAME_STARTED after kickoff
- 33 Draft complete — section-glow end state, pinned action is the Week 1 lineup
- 34 Dead invite link — names which of the three death reasons applied, offers
  public leagues / create instead of a wall

### screens/Rostr Landing.dc.html — phone breakpoint added
The design had no rules below 980px; at 390px the nav, hero draft board (min ~470px),
rules table and the two-column close band all overflowed, which is the clipped dark
band on the right. Added a max-width:640px pass: nav compacts (tagline + How-it-works
hidden), hero/section paddings tighten, the board scrolls horizontally instead of
clipping (mask dropped when scrolling), the rules table stacks its label cells, the
close band and week split collapse to one column.
**The shipped page.tsx needs the same treatment — this fixes the design, not the app.**

### Stale copy corrected (per STATUS.md / ANSWERS.md)
- Roster-as-NFT sentences removed: Mobile hero, Draft Room draft-complete,
  Playoffs "Your roster, now", Trade Veto escrow caption. Replaced with the
  no-commissioner claim the app actually ships.
- Kickoff corrected to 9 September (Create League helper text, Draft Room).
- Domain: rostr.gg → rostr.site everywhere (Mobile ×24, Invite and Join ×1).

## Not touched
- Rostr Screens.dc.html is still the drop-8 index (17 mobile frames, stale open
  questions) — update separately or with the next drop.
- Draft room state 6 still exists on desktop; ANSWERS.md says it can be deleted.

## How to land this
```
git checkout -b design-drop-9
cp -r handoff/docs/design/screens/* docs/design/screens/
git add docs/design && git commit -m "Design drop 9: mobile complete (34 frames), responsive landing, retired copy removed"
gh pr create --draft --title "Design drop 9" --body-file docs/design/PULL_REQUEST_DROP9.md
```
Open as a **draft PR** so it is not mergeable until you have been through it.
Note: design-scoring.test.ts guards the Create League table — it was not changed here,
only the kickoff date helper text, so it should stay green.
