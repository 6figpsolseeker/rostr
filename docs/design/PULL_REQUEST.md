Branch: `design/screens`

---

## Add the design reference for the whole product

Twelve files, thirty-seven states, covering rostr end to end: the public landing page,
creating and freezing a league, inviting and joining it, the draft lobby and the order draw,
the draft room and its failure branches, the weekly in-season loop including the full trade flow, the playoffs and
settlement, amending and dissolving a league, and ten screens designed for mobile web.

Nothing here is wired into `apps/web`. `design_handoff/` is the reference to build against.

### What's here

| File | States |
| --- | --- |
| `Rostr Landing.dc.html` | 2 hero animation variants — pick one |
| `Rostr Create League.dc.html` | Settings, then the freeze |
| `Rostr Invite and Join.dc.html` | Commissioner's side, invited manager's side |
| `Rostr Draft Lobby.dc.html` | Before the draw, and the draw |
| `Rostr Draft Room.dc.html` | On the clock, waiting, signing, autopicked, disconnected, pick rejected, complete |
| `Rostr League Home.dc.html` | League home, full matchup |
| `Rostr Lineup.dc.html` | Setting it, partially locked |
| `Rostr Waivers.dc.html` | Filing claims, the Wednesday run |
| `Rostr Trade Veto.dc.html` | Propose, accept, veto window, settled |
| `Rostr Playoffs.dc.html` | Bracket live, settled |
| `Rostr Amend and Dissolve.dc.html` | Propose, stuck at 9/12, dissolve, auto-dissolve |
| `Rostr Mobile.dc.html` | 10 screens at 390px |

All copy is grounded in `README.md` and `docs/RULES.md` — the differentiators, the format
table, the multi-sport paragraph and the rule-set documents are the repo's own words.

### Read the README's second section first

Most defects found while designing these were not visual. They were the same league
described inconsistently across two files: a 6-team lobby feeding a 12-team draft room, a
roster limit of 15 on one screen and 14 on the next, a 48-hour veto window whose timestamps
spanned 77 hours, standings ordered against their own stated tiebreaker, one player
simultaneously rostered on one screen and undrafted on another, and the Week 1 kickoff date
authored three different ways across three screens.

The README lists the eleven facts that must be **derived from one source and never
restated** — roster limit, standings order, veto threshold, veto deadline, draft order,
autofill target, positional need, lock state, season dates, snake-pick arithmetic, bracket
shape. That table is the most useful thing in the bundle.

### Four findings worth surfacing

**Only ten values are the commissioner's.** Scoring is set by the project, the pot token by
the service. So the create-league page is mostly disclosure, not configuration — which is
what it was designed as.

**Autopick has to sign a transaction the manager wasn't present for**, and the same
round-trip creates a state where a manager loses the player they chose: a wallet prompt can
outlive the blockhash it signed against, so a pick can fail *and* the clock expire during
the automatic retry. Draft room state 6 designs that state; pre-signing or a session key
would remove it. Architectural, and worth settling before the escrow program is written.
The notice strip reads "signed 0x7f3a…c19d" without claiming a mechanism — don't ship that
line until the mechanism is real.

**The draft clock cannot pause on disconnect.** Closing a laptop would buy unlimited
thinking time and no commissioner can adjudicate whose outage was real. State 5 therefore
names exactly which player autopick will take instead of showing an error, and labels the
countdown as an estimate.

**The draft lobby is the best demo of the product's argument.** The order doesn't exist
until the block is produced, and the verification panel gives slot, blockhash, both block
times and the seed recipe so anyone can recompute it.

### Two mechanical notes

`disabled="disabled"`, not a bare `disabled` — the latter compiles to `disabled=""`, which
React drops, so every acknowledgement gate in this set renders as a live button next to an
unchecked box. It happened once here and it is invisible until someone taps it.

Mobile tap targets are ≥44px throughout. Ten elements were under it on first write, mostly
at 40px, which looks fine and misses under a thumb.

### Not done

- **Five desktop screens have no mobile design** — create league, the commissioner's invite
  side, draft lobby, amend and dissolve — and neither does the playoff bracket, which
  is the hard one: three reseeded rounds will not sit side by side at 390px.
- Player detail, full standings.
- **One convention undecided:** when a week label flips. These screens call Tuesday 17 Nov
  "Week 10" though Week 10 finished Monday and Week 11 starts Thursday. No arithmetic depends
  on it, but the waiver run and the trade deadline both read "current week" from it.
- The wallet signing round-trip is designed three times and needed in three more places:
  freezing a league, voting, and any pot action.
- Every player name is invented. Swap for Tank01 before showing this to anyone.
