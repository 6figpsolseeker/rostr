# CLAUDE.md

Context for Claude Code sessions on this repo. Read this first — it is the handoff
between machines and between sessions.

---

## What this is

**rostr** — open-source fantasy sports on Solana, football first. Web app and native app,
targeting the **Solana Seeker dApp Store**.

Owner: [@6figpsolseeker](https://github.com/6figpsolseeker). Previously shipped
[`percolator-mobile`](https://github.com/6figpsolseeker/percolator-mobile) to Seeker
(React Native 0.81 + Expo 54 bare, Mobile Wallet Adapter, Seed Vault) — **use it as the
reference build for anything mobile.**

The thesis in one line: every other fantasy platform asks you to trust an administrator;
this one replaces that trust with immutable rules, escrowed funds, and automatic
settlement.

---

## Hard deadlines

Today's date matters more than usual here.

| Date            | What                                                          |
| --------------- | ------------------------------------------------------------- |
| **Aug 22 2026** | Leagues must be creatable, joinable, fundable, **draftable**  |
| **Sep 9 2026**  | **NFL kickoff.** Lineups lock, scoring runs, matchups resolve |
| Sep 16          | Waivers (Week 2)                                              |
| Nov 22          | Trade deadline (Week 11)                                      |
| Dec 13          | First real payout — regular-season prize (Week 14)            |
| Jan 3 2027      | Championship (Week 17)                                        |
| Jan 10 2027     | Final payouts, after the 7-day correction window              |

Two of these are hard: **Aug 22** and **Sep 9**. Everything else has months of runway.
Miss the season and the next real-data window is September 2027.

**The NFL calendar is the release schedule.** Settlement code does not run until January.
Do not build it in August.

---

## Where we are

See [`docs/BUILD-PLAN.md`](docs/BUILD-PLAN.md) for the full commit-by-commit plan.

**Done — 815 tests, CI green:**

- Full specification — rules, data model, live scoring, build plan
- A1: pnpm monorepo, TS strict, vitest, eslint, prettier, CI
- A2: sport registry (`packages/core/src/sports/`)
- A3–A5: canonical encoding, rule schema, hashing, validation
- A6: Postgres migrations (`packages/db/migrations/`), forward-only runner, PGlite tests
- A7: `seedSport()` and `createLeague()` — validate, hash, freeze, all in one transaction
- A8: `@rostr/pinning` — pin the canonical document, verify the round trip, `setRulesUri()`
- A9: identity — users, email verification, wallet linking
- A10–A11: `apps/web` — Next.js 15, Tailwind 4, wallet adapter, full rules rendered
  before the join control
- A12: `buildJoinMessage()` / `joinLeague()` — signature over the rules hash, verified
  server-side

- B1–B5: the scoring engine (`packages/core/src/scoring/`) — integer milli-points, tiered
  ladders tested at every boundary

- B9–B15: snake draft, queue, auto-pick, bots (`packages/core/src/draft/`)

- Waivers and free agency (`packages/core/src/waivers/`) — ESPN's cycle exactly:
  Tuesday 00:00 ET back to waivers, Wednesday 03:00 ET processing, free agency between,
  1-day waiver period, 24-hour short-tenure rule

- C1, C9, and all of C8: schedule generation, records, tiebreaker chain, playoff seeding
  (`packages/core/src/season/`)

- **C6 and the rest of C8** — `season/results.ts`. Team-week scoring from stored lineups,
  and the `MatchupResult`s the standings consume. This was the missing join: the scoring
  engine and the standings table were both finished and had no way to reach each other.

- B6–B8: Tank01 adapter, box scores, live sync (`packages/stats/`, `packages/db/sync.ts`)

- B16: the draft persisted (`packages/db/src/draft.ts`, migration `0009`)

- The draft order drawn once from a Solana block, field locked at the draw (migration
  `0010`)

- Sessions, emailed sign-in links, and wallet linking by signature (migration `0011`,
  `packages/db/src/sessions.ts`, `apps/web/src/lib/session.ts`)

- The draft room (`apps/web/src/components/DraftRoom.tsx`, `api/leagues/[id]/draft/`)

- League creation, with a live rules preview; the draft is scheduled with the league

- `/api/cron/draft-tick` — clocks advance without anyone watching

- C2, C3 and C10: lineup validation, per-player kickoff locks, and the deterministic
  autolineup (`packages/core/src/season/lineup.ts`, `autolineup.ts`)

- Lineups persisted and editable (`packages/db/src/lineups.ts`,
  `apps/web/src/components/LineupEditor.tsx`), and the week resolved end to end
  (`packages/db/src/week.ts`, `/api/cron/score-week`)

- Waivers and free agency wired end to end (`packages/db/src/waivers.ts`,
  `apps/web/src/components/PlayerMarket.tsx`, `/api/cron/waivers`)

- The season schedule drawn when the draft completes, league state transitions, and a
  standings screen

- **D1–D5: the escrow program** (`programs/rostr-escrow/`) — Anchor workspace, the league
  account with its terms frozen, join by rules-hash acceptance, deposit to a vault, and
  the unconditional timelock refund. Free leagues anchor their rules hash the same way.
  55 tests green on localnet via `anchor test`.

- **`@rostr/escrow`** — the client half. Addresses, the committed IDL and its generated
  type, and instruction builders for all five instructions. The whole money lifecycle
  (anchor → join → stake → refund) is exercised through it against the real program.

- **The on-chain anchor recorded** (migration `0014`) — transaction and cluster, write-once
  by trigger. `recordChainAnchor` / `getChainState` in `packages/db/src/leagues.ts`.

**Both hard deadlines are now covered in code.** Aug 22 is create → join → draft; Sep 9 is
set a lineup → score the week → standings. What they need is deployment and the
credentials in `SETUP-REQUIRED.md`, not more code.

**Next, in order:**

1. **Wire anchoring into the app.** Everything underneath exists: `@rostr/escrow` builds
   the instructions, migration `0014` records the result. What is missing is the route
   that verifies the anchor on-chain before recording it, and the screen where the
   commissioner signs it.

   **Blocked on credentials, not on code** — `SOLANA_RPC_URL` (the route's entire job is
   reading the account back, which needs an endpoint) and Supabase (`DATABASE_URL`, or the
   app does not get past its home page). Writing it without those means code that
   typechecks and has never once run, on the path that moves money. Set both first.

   **Decided 2026-08-07: the commissioner signs from their own wallet**, not a server
   keypair — so no private key of ours exists anywhere, and there is none to fund, rotate
   or lose. The cost is that a league can exist here unanchored, because someone can close
   the tab; the partial index in `0014` finds those.

2. **D6–D10** — the rest of the escrow. **This is main-PC work**; the secondary machine has
   no Rust toolchain. Note that **D6 is not a small job**: "payout by the frozen split"
   needs to know who won, and `RULES.md` § 7 says nobody declares a winner — the contract
   derives it from posted scores. That makes D6 depend on G4–G8 (dual-source oracle, scores
   on-chain), which the build plan schedules for Dec–Jan. Do not start D6 expecting an
   afternoon.
3. **Pot leagues still cannot take money in the app**, and must not, until 1 lands and D6
   can pay it back out.
4. **The playoff bracket.** `playoffField` seeds it; nothing plays it. Weeks 15–17. This
   is the largest remaining piece that needs no credentials and no Rust.

**Still open on the draft:** nothing, on the fairness side — the grindable seed is fixed
(see "The order draw" below). What remains is operational: `SOLANA_RPC_URL` has to be
set, and verifying an old draw needs an archival node.

### The draft

`packages/core/src/draft/`. Pure state machine — transitions return new state, nothing
runs a clock or touches a database. That is why slow drafts need no real-time
infrastructure and why a full 12-team draft plays out instantly in a test.

- **Order is seeded, never `Math.random`.** Anyone holding the seed can recompute it and
  confirm nobody reshuffled.
- **The seed comes from the chain, and only after the field locks.** See below — this was
  the one genuinely exploitable hole in the design and it is now closed.
- **Roster legality is bipartite matching** (`roster.ts`), not per-position counting.
  Counting is _wrong_ because of FLEX — see the comment at the top of that file before
  changing it. This underpins the rule that stops six quarterbacks and no kicker.
- **One auto-pick routine serves clock expiry and every bot.** Do not fork them. Two
  implementations would diverge, and the divergence would read as "the bot outdrafted me
  while I was asleep".

Bot sophistication is still the open question: the current bots draft by need from a
supplied ranking. Positional scarcity, bye weeks, and tier breaks are not modelled.

#### The order draw — do not simplify this

`packages/db/src/randomness.ts` and `packages/core/src/draft/seed.ts`.

The seed is the first Solana block produced at or after the league's frozen
`scheduledAt`. **A seed known before the field is locked is worthless**, because the
shuffle depends on the seed _and_ the set of team IDs: a commissioner adds a bot,
computes the order offline, removes it, tries another, and repeats until it suits them.
Every order they computed is correct. Nothing about the published one looks wrong. No
server-side check can catch it — the grinding happens on their laptop.

Four things close it, and removing any one reopens it:

1. `drawDraftOrder` refuses before `scheduledAt`.
2. The rule names **exactly one** block — the _first_ at or after that instant — so there
   is no "try again a few slots later". `SolanaBeacon.verify` is what proves a recorded
   slot really is that one, in two RPC calls.
3. A trigger rejects any second write to the draw or to any team's `draft_position`.
4. A trigger locks the field: no team may join once the order is drawn.

`SolanaBeacon.firstBlockAtOrAfter` is a binary search over block times, tolerating
skipped slots. Roughly twenty RPC calls; a linear walk would be millions. **Verification
of an old draw needs an archival RPC node** — public nodes prune, and a pruned range
looks the same as a stalled chain.

`FixedBeacon` is test-only. It makes the seed predictable, which is the entire thing the
real one exists to prevent.

**Persistence lives in `packages/db/src/draft.ts` and adds exactly one thing the engine
cannot do: arbitration.** The engine is pure and single-threaded, so when two managers
click at the same instant both read "pick 15 is open", both validate, and both are right.
The database decides instead — `SELECT ... FOR UPDATE` on the draft row is the fast path,
and `PRIMARY KEY (draft_id, pick_number)` plus `UNIQUE (draft_id, player_id)` are the
backstop if anything ever writes outside that lock. Both are tested.

A pick writes the `draft_picks` row, the `roster_entries` row, and the queue cleanup in
**one transaction**. A pick recorded without a roster entry leaves a team owning a player
nothing else in the system can see.

`PickRow["source"]` is imported from the engine, not restated. Writing that union out by
hand is how the `draft_pick_source` enum and the engine drifted apart the first time —
the migration had `NEEDED_SLOT` and `ANY_LEGAL`, which the engine has never emitted.

#### Projections and how the board is ordered

The board groups by **position** and sorts by **projected season points**, with ADP as
the tiebreak. Comparing a quarterback's 334 against a kicker's 133 tells you nothing —
you need one of each. What matters is who is the best one left at a position.

**Projections are stored as raw stats and scored with each league's own rules.**
`player_projections` (migration `0013`) holds stat lines, never points. Tank01 ships a
`fantasyPointsDefault` and it is discarded on purpose: ours pays 4 for a passing
touchdown, so a provider's number on the draft board would disagree with the number that
decides matchups. The same `scorePlayer()` produces both.

One provider call covers the whole season — `getNFLProjections` with **no `week`**.
See [`docs/TANK01.md`](docs/TANK01.md), which records the verbatim response shape.

**Kicker projections are a floor.** The provider gives a total `fgMade` with no distance
split and our scoring pays 3/4/5 by distance, so everything lands in the 3-point tier.
Harmless because the board groups by position; do not "fix" it by inventing a
distribution.

`syncProjections` batches deliberately. Row-at-a-time against a hosted database was 5,600
round trips, took minutes, and the connection died partway through. One query for the
player map, then chunked multi-row upserts — 500 rows a chunk, because Postgres caps a
statement at 65535 bind parameters.

#### The draft room

`apps/web/src/components/DraftRoom.tsx` and `apps/web/src/app/api/leagues/[id]/draft/`.

**Polls, does not hold a socket.** A 90-second clock does not need sub-second updates,
polling survives sleep and tab-switching with no reconnect protocol, and the server keeps
no per-connection state — which matters when it runs as serverless functions.

**The interval is adaptive, and that is the part that matters.** Three seconds is
invisible while you watch someone else pick; it is not invisible when the turn reaches
you, because a poll landing three seconds late costs three of your ninety. So it drops to
one second while you are on the clock **or on deck** — being on deck is the important
half, since the fast poll is then already running when it flips to your turn. `onDeckTeamId`
is computed server-side rather than in the browser, so there is one implementation of the
snake and the room cannot disagree with itself about whose pick it is.

The board is fetched **once** and availability computed client-side by subtracting drafted
players. A thousand players is ~80 KB and only changes when the stats sync runs; shipping
it on every 3-second poll would be silly.

**`catchUpExpiredPicks()` runs on every read of the draft.** That is how clocks expire —
there is no scheduled worker yet. It is deterministic and idempotent, so it does not
matter who triggers it.

Each auto-pick is stamped **at the deadline it missed, not at `now`**, and that is
load-bearing. Stamping `now` restarts the next manager's clock from whenever somebody
happened to open the page: an hour of nobody watching would cost exactly one pick and
silently extend every clock after it. Advancing deadline by deadline keeps the draft on
real time. Tested.

**`/api/cron/draft-tick` is what makes clocks real.** Before it existed, expiry happened
only when somebody _read_ a draft, so a draft nobody had open did not advance and a
manager who went to bed could return to find their clock had never run. It must fire **at
least as often as the shortest pick clock** — a minute, given the 90-second minimum.
`apps/web/vercel.json` schedules it; anywhere else, point cron at the URL.

Set `CRON_SECRET` to stop it being hammered. It is not a security boundary in the usual
sense: the endpoint only does what the clock already permits, so an unauthorised call
cannot produce a wrong pick. The guard is about database load.

It also purges expired sessions and idle rate-limit buckets, because those need a
scheduler and nothing else did.

Clocks are **computed from `clock_started_at`, never scheduled.** That is what lets a
24-hour slow draft run with no timer infrastructure: `draftsWithExpiredPicks()` returns
the work list and a job auto-picks through it. A pause clears the clock, so a manager
resumes with a full fresh timer rather than losing sixty of their ninety seconds to an
outage they had nothing to do with.

### The season

`packages/core/src/season/`. Both files are pure — no clock, no database.

**The schedule is a seeded round robin**, from the rules hash, by the circle method. Two
things it must keep doing, each of which was a real bug caught by a test:

- **Sort the team IDs before shuffling.** A shuffle permutes positions, not identities,
  so shuffling the caller's array made the schedule depend on the order teams were passed
  in — and therefore on database row order.
- **Assign home and away in a second pass**, to whoever is furthest behind. Deriving it
  from the rotation geometry gave one team eleven home games out of fourteen, because
  only the held team keeps a fixed pair index.

Odd leagues get byes, spread evenly. A bye is not a game: no win, no loss, no points, and
it does not count toward games played, so win percentage stays comparable.

**Standings resolve ties by group, not pairwise.** A comparator that consults each
tiebreaker in turn is _wrong_ for head-to-head: A beating B says nothing about C, so
`a > b > c > a` is reachable and the result depends on what the sort algorithm visited.
Instead, rank by one tiebreaker, then re-apply the next _within_ each still-tied group.
Head-to-head is skipped entirely when the tied teams did not all meet the same number of
times — comparing records across different schedules is not a tiebreaker.

`computeStandings` **throws** if the chain runs out with teams still tied. Falling back to
input order would make a playoff seed depend on database row order, and playoff seeds
decide who can win the pot.

### Lineups and the autolineup

`packages/core/src/season/lineup.ts` and `autolineup.ts`. Pure, so the same rules govern a
manager's edit, a bot's week, and an abandoned team.

**A slot locks at the kickoff of _that player's_ game**, not at the week's first kickoff.
So a Thursday player being locked does not stop a manager reacting to a Sunday-morning
injury. Two behaviours look like oversights and are not:

- **An empty slot never locks.** Nothing has happened in it for anyone to react to.
  Locking empty slots at the first kickoff would punish forgetting rather than prevent
  cheating.
- **A player on a bye never locks.** There is no game to have started, so that slot stays
  fillable — with a Monday-night player, for instance.

A locked slot may **keep** its player; it may not change. Rejecting the slot outright
would make submitting a whole lineup on Sunday fail because of a Thursday slot the
manager can do nothing about.

**The autolineup is deterministic, and that is the whole point.** An abandoned team plays
out the season and its results move other people's playoff seeds — which in a pot league
decides who gets paid. Season-to-date average, ties broken on player ID. Tested for
reproducibility and for independence from roster order.

**Scarcest slot first.** With one tight end on the roster, filling FLEX first takes him
and leaves TE empty. There is a test.

An unavailable player still gets started when there is nobody else: an empty slot and an
inactive player both score nothing, but only one keeps the lineup legal.

**Persistence is `packages/db/src/lineups.ts`.** The lock is enforced there, not just
greyed out in the UI — `setLineup` loads what is _currently stored_, works out which slots
have kicked off, and refuses any change to them. A crafted request gets the same answer as
the screen.

`ensureLineups` is what makes `resolveWeek`'s precondition true. That function throws when
a scheduled team has no lineup, deliberately — scoring a missing team as zero hands its
opponent a free win — so the autolineup fills every gap before a week is scored.

### Scoring and finalising a week

`packages/db/src/week.ts`, run by `/api/cron/score-week`. The persistence and job half;
the pure arithmetic is "Resolving a week" further down.

**Scoring and finalising are separate decisions.** Points are rewritten on every run so a
manager can watch their week; `finalized_at` is set only once every game is `FINAL` **and**
the correction window has elapsed. A finalised week is never rescored — in a paying week it
has already decided money, and a silently changed result afterwards is exactly what the
window exists to prevent.

The window comes from the rules: 48 hours normally, **168 for weeks 14 and 17**, because
official NFL stat corrections arrive for up to seven days.

Scores read `stat_lines_current`, so a correction that arrived as a new revision is used
and the superseded one is not. There is a test for that specifically.

`persistSchedule` refuses to overwrite an existing schedule. Rewriting mid-season changes
who played whom, and every record derived from it.

**The schedule is drawn when the draft completes**, inside the same transaction as the
final pick, seeded from the draft's own order seed. So it is as checkable as the draft
order and for the same reason: schedule luck is retained deliberately, which means nobody
may be able to arrange it. A league that finished drafting with no fixtures would look
finished and be unplayable.

`generateSeasonSchedule` deliberately **does not open a transaction** — it is called from
inside one. `withTransaction` issues a real `BEGIN` on whichever client it is given, so a
nested call would make the inner `COMMIT` commit the outer work too. Use `persistSchedule`
when you need the transaction.

### Waivers

`packages/db/src/waivers.ts`, run by `/api/cron/waivers` hourly. The rules are in
`@rostr/core`; this module loads their inputs and applies their outputs, and decides
nothing.

**A drop is not a delete.** Held 24 hours or more, a player goes to waivers; held less, he
goes straight to free agency. That second rule is ESPN's and it stops a manager adding
someone, cutting him hours later, and re-adding him to dodge the queue.

**One route handles add, claim and drop**, and which one happens is decided by the
player's availability rather than by which button was pressed. A client that could choose
would be able to ask for an immediate add on a player who is on waivers — which is exactly
what waivers exist to prevent.

Two properties of `processWaivers` are load-bearing: it is **blind** (resolution cannot
depend on submission order) and **replayable** (pure, so a disputed run can be re-run
rather than argued about). Both come from `resolveWaiverClaims`; do not reimplement them
here.

Priority is seeded at draft completion, reversed from the draft order. Winners move to the
back, losers do not move at all — a failed claim costs nothing, so there is no reason to
hoard claims.

**Watch the clock in tests.** A player dropped Monday afternoon clears at Wednesday 03:00
**Eastern**, which is 07:00 UTC — so a test using "Wednesday 18:00 UTC" is _after_ the
clear, not before it. One test asserted the opposite and was wrong.

### Trades

`packages/core/src/trades/veto.ts` (pure), `packages/db/src/trades.ts` (state),
`/api/cron/trades` hourly, `TradeBlock.tsx` on `/leagues/[id]/trades`. Three points were
settled by the owner on 2026-08-08 and written into `docs/RULES.md` §6 — **do not
re-open them**: the deadline is **commissioner-set** (default 11), **bots are not in the
veto denominator** (one third of uninvolved _managers_), and there is **no commissioner
override**.

**Nothing here asks who is asking.** There is no commissioner argument on any function —
an absence, not a check that could be relaxed later. If you find yourself adding an
"isAdmin" parameter, that is the thing this project exists to remove.

**An empty electorate lets a trade stand.** Two managers and a bot leaves zero uninvolved
voters, so `vetoesRequired` returns 0 — and a threshold of zero would otherwise mean every
trade is vetoed before anyone votes. `isVetoed` short-circuits it.

**Accepting freezes the players; it does not move them.** Between acceptance and execution
they are in escrow: `lockedByTrade` is consulted by `dropPlayer` (which throws
`IN_A_TRADE`) and by `proposeTrade`. Without it a manager accepts a trade and cuts the
player they promised, and execution finds a hole where a roster spot used to be.

**Execution releases and re-adds roster rows rather than repointing them.**
`roster_entries` is append-only with `released_at` precisely so any past week's roster is
reconstructible; a trade that edited history would make a settled week unverifiable. It
does **not** go through `dropPlayer` — a traded player must never surface on waivers.

**The deadline is checked twice, against the week the trade would _execute_.** At proposal
against the earliest week it could land in, and again at resolution — a trade left
unaccepted for days slides past the first check. A window closing past the deadline
**expires** the trade, rosters untouched. That is what `EXPIRED` in the `trade_state` enum
is for; it was unused before.

**`currentWeek()` in `week.ts` exists so no route takes a week from the client.** A
deadline checked against a client-supplied week is not a deadline — anyone could trade in
January by posting `week: 1`. Routes that legitimately display an arbitrary week (a past
lineup) still accept one; routes enforcing a rule must not. `score-week` had this query
inline and now shares it.

**Bots neither trade nor vote.** A bot has nobody to weigh an offer, so proposing to one
would either strand the trade or make the bot judge it — and a bot that judges trades is a
commissioner with extra steps.

`buildNflPprRules` gained a `trades` override so the commissioner can set the deadline at
creation. The route validates the result rather than trusting the number, because it is
the one rule field a client supplies directly and the rules are frozen the moment they are
written.

### Abandonment is gone. Do not bring it back

Removed 2026-08-08 in schema 4, along with `teams.strikes`, and **decided by the owner** —
not a simplification somebody took on themselves.

It could never fire: it counted consecutive weeks with an _invalid_ lineup, and the
autofill runs before a week is scored, so a lineup is never invalid at that moment.

It was removed rather than repaired. A manager who stops setting lineups is not defrauding
anyone, the autofill already keeps their team competitive so the league is not harmed, and
a stake forfeited for inattention is a rule people would only meet by losing money to it.
It also deletes **D7** from the escrow — an instruction that would have moved one member's
stake to another based on a strike count, in unaudited code.

Reasoning in full in `DECISIONS.md`, including the two alternatives that were rejected.

### Bots: one, and none where there is money

`league.maxBots` in the frozen rules, enforced in `addBot`. **Zero in any league with a
pot** — a bot has no wallet and paid no buy-in, so a bot champion would leave 60% of the
pot with no recipient, on-chain, where there is nobody to appeal to. Barring the case is
simpler than every rule that tries to handle it, and it means the escrow program never has
to know what a bot is.

Otherwise one, and only when the manager count is **odd**. A bot squares five friends;
adding one to an even league creates the bye it exists to prevent. `removeBot` gives the
seat back when a sixth person turns up, and refuses once the draft order is drawn — the
field is locked at that moment for everyone.

`botsAllowed: boolean` became `maxBots: number` in the same change. The boolean sat in the
frozen rule set and was **enforced nowhere** — a guarantee members signed that did nothing.
One field also cannot disagree with itself the way "allowed" and "how many" can.
schemaVersion 2 → 3.

**Tests use `addTestTeam` from `testing.ts`, not `addBot`.** A fixture built out of bots
describes a league that cannot exist. The helper produces the same rows a real join
produces, minus the signature.

### Joining requires the anchor

`joinLeague` refuses an unanchored league. Joining signs the rules hash, and the point of
that signature is that the rules are provably fixed — before the anchor, the only thing
holding them still is a row in our own database, which is the arrangement this project
exists to replace. A member who signed first would have consented to a promise.

**`addBot` is deliberately not gated.** A bot signs nothing, stakes nothing and consents
to nothing, so there is no consent for the anchor to protect. Gating it would break
fixtures and protect nobody.

`requireCluster` exists because the PDA is identical on every cluster, so a devnet anchor
and a mainnet one are indistinguishable unless the caller says which it means. The join
route passes `SOLANA_CLUSTER`.

Test fixtures call the real `recordChainAnchor` rather than writing the column directly,
so a fixture cannot drift into a state the application could not produce.

**League state transitions live in the draft**: `startDraft` moves FORMING → DRAFTING, and
the final pick moves it to IN_SEASON. Nothing else moved state before, so a drafted league
stayed FORMING forever — still accepting members, and invisible to every job that works on
live leagues. The enum is FORMING / DRAFTING / IN_SEASON / PLAYOFFS / SETTLED / DISSOLVED;
an invented value is not a no-op, Postgres fails the cast and the query errors.

### Resolving a week

`packages/core/src/season/results.ts`. C6 and C8 — the join between the scoring engine and
the standings table, which were both finished and had no way to reach each other.

Most of it is converting between the two representations of a lineup that both have to
exist: stored as `(slotType, slotIndex, playerId | null)`, which is what a manager edits
and what the database keys on, and consumed as `(slotType, playerId, stats)`, which is
what scoring needs. Neither side should learn about the other, so the conversion lives
here — and so do the three cases that only appear at the join.

**Empty slot, absent stat line, and missing team are three different things.**

- An **empty slot** scores nothing. A manager who left one empty scores zero for it; that
  is the rule, not a fault, and it must not take the week's scoring down with it.
- A player with **no stat line** scores zero. Inactive, on a bye, or his game is not
  ingested yet — all three look identical here and none is an error.
- A **team with no lineup** throws. Every team plays every week and the autolineup exists
  so an abandoned team still has one, so a missing team means the caller lost it. Scoring
  zero would hand its opponent a free win off our bug, which moves a playoff seed.

Starters go through `scoreTeamWeek` rather than being re-totalled, so the rule about which
slots count stays in one place. Bench players are scored with `scorePlayer` and appended
as `counted: false` — they never pass through the starter filter, so `BENCH_SLOT` is a
display label and cannot affect a total.

**A player in two slots throws.** `validateLineup` already rejects it on submission, but a
duplicate silently doubles his points and this is the last place it can be caught before
money moves.

### Scoring

`scorePlayer()` and `scoreTeamWeek()` in `packages/core/src/scoring/engine.ts`. Pure, no
I/O, no sport knowledge — a test scores an invented cricket-shaped rule set to prove it.

Three behaviours that are deliberate and should not be "fixed":

- **Absent is not zero.** A stat key missing from the input contributes nothing. Correct
  for a player who did not appear — but it means a defense that allowed 0 points needs an
  explicit `def_pts_allowed: 0` to earn the shutout bonus. **That is the provider
  adapter's job.**
- **An uncovered tier value throws.** A negative points-allowed means the feed is broken;
  scoring zero would bury it.
- **Bench and IR are scored but not counted.** Managers want to see what they left out.
  The filter comes from the league's own roster rules, not a hardcoded slot list.

Fixtures in `scoring/fixtures.ts` are **constructed, not real box scores**, and labelled
as such. Validating against real 2025 data is the outstanding half of B5 and needs the
Tank01 key.

### The escrow

`programs/rostr-escrow/`, Anchor 0.31.1. Run it with `anchor test` — which builds, starts
a validator, deploys, and runs `programs/*/tests/**/*.test.ts` through a **separate**
vitest project (`vitest.program.config.ts`). `pnpm test` deliberately does not include
them: the 630 tests under `packages/` need no toolchain, and that should stay true.

**Immutability is by omission.** No instruction mutates a `League` after
`initialize_league`, and the account has **no authority field** — so there is nobody who
could be tricked or coerced into changing terms, rather than an authority check that must
be right every time. Adding a setter reopens everything `DECISIONS.md` § "Commissioner
powers are bounded by the contract" closes.

**`refund_stake` has exactly three conditions**: the clock has passed, you staked, you
have not already been refunded. It consults no league state, no settlement, no member
count. **Every extra condition is a new way for money to become permanently stuck**, which
is the one failure this program exists to make impossible. This is why BUILD-PLAN says
ship it first. Do not add a condition to it.

**`deposit` takes no amount argument.** It moves `league.buy_in` and nothing else, so
"everyone stakes the identical amount" is structural rather than a check that could be
reordered around. A member who wants to overpay has no instruction that permits it.

**Legacy SPL Token, not `token_interface`** — deliberate, and worth not "modernising". A
Token-2022 mint with the transfer-fee extension delivers less to the vault than the member
sent, silently breaking equal stakes; a transfer hook is arbitrary code inside a deposit.
USDC is a legacy mint. Milestone E's roster NFTs are Token-2022 and unrelated to this.

**The vault's authority is the league PDA**, so no key held by any person can move the
pot — only this program, only through these instructions.

`payout_bps` is positional, indexed by the `prize` module. **That order is
`NFL_DEFAULT_PAYOUT` in `rules/nfl-ppr.ts`, not the declaration order of the `PrizeKey`
union** — the two differ, and a client serialising from the wrong one reshuffles the split
without any error.

**The buy-in is $5 to $50** — `MIN_BUY_IN_BASE_UNITS` and `MAX_BUY_IN_BASE_UNITS`, decided
2026-08-07. A range, not a price: any amount in between is valid, and there is a test that
says so for 5, 10, 25, 47 and 50. The floor exists because a pot has fixed costs a stake
does not scale with — transactions, rent, five payouts — so below a few dollars the pot
costs more to move than it pays. For the ceiling to
mean fifty _dollars_ the program also requires pot mints to have **six decimals**
(`POT_MINT_DECIMALS`), because base units are mint-specific and the same constant would
otherwise be 0.05 SOL at nine. That narrows `RULES.md` § 7's "any SPL token" to stablecoins
for season one, deliberately. It is **not** proof of value — a six-decimal token worth $100
would sail past the cap — and closing that means pinning USDC's mint before mainnet. See
`SETUP-REQUIRED.md`.

**Free leagues get their own instruction**, `initialize_free_league`: no mint, no vault, no
buy-in, no payout, no fee — but the rules hash is anchored exactly as a pot league's, and
members accept it through the same `join_league`. Otherwise "the rules are immutable and
you can verify them" would hold only for leagues with money in them, and everyone else's
guarantee would be our database. Separate from `initialize_league` rather than a flag
because the account set genuinely differs; making the mint and vault optional would let a
caller create a pot league that can never take a deposit.

**The fee is 1%, taken once at settlement**, capped on-chain at 5% (`MAX_FEE_BPS`, mirrored
in `packages/core`). It lives in the **hashed rule set** — `pot.feeBps` and
`pot.feeRecipient`, frozen per league and signed by members — because a fee the operator
could change afterwards would make the immutability claim untrue of the one party with the
most to gain from breaking it. **A timelock refund is never charged**; an escape hatch that
costs a percentage is a weaker guarantee, and that guarantee is why this is shippable
before review. Adding it moved the rule schema to **version 2** and therefore the golden
hash — see the changelog in `rules.test.ts`.

`FEE_RECIPIENT` is server-side configuration and is **never read from a request**: a
client-supplied recipient could redirect the fee, a client-supplied rate could zero it.
Unset, leagues are created fee-free, which is fine locally; in production the route
refuses, because frozen rules mean a league created with the wrong recipient can never be
corrected.

### The escrow client

`packages/escrow/`. Addresses and instruction builders, and **nothing that signs**. A
league is anchored by its commissioner's wallet and a stake moved by the member's, so no
key of ours exists in the flow — there is no server-side signer to fund, rotate or lose.
If you find yourself adding one, that was a decision (2026-08-07) and not an oversight.

**The IDL and Anchor's generated type are committed**, and that needs saying because it
looks like checked-in build output. `anchor build` writes both to `target/`, which is
gitignored, but the web app needs the program's interface and neither Vercel nor the
TypeScript CI job has a Rust toolchain. So `pnpm idl:sync` regenerates them and
`pnpm idl:check` fails when they drift. **The check runs in the Anchor job** — the only
place both halves exist to be compared. Both files are in `.prettierignore`; formatting
them would make the check compare prettier's output against the generator's and fail
forever.

**`.accountsPartial()`, not `.accounts()`.** Anchor 0.31 rejects accounts it can derive
itself, so the typed call refuses PDAs. Passing them explicitly means the addresses come
from `packages/escrow/src/program.ts` — the derivation the program suite actually
cross-checks — rather than from Anchor's resolver. One source of truth, and it is the
tested one.

**`payoutArray()` is the only place the payout order is converted.** `PRIZE_ORDER` here
matches the program's `prize` module, which is `NFL_DEFAULT_PAYOUT` order and **not** the
declaration order of `PrizeKey` in `@rostr/core`. Serialising from the wrong one reshuffles
the split with no error anywhere. The test passes the shares deliberately shuffled, because
in declaration order the bug is invisible.

A league's Postgres UUID is its on-chain seed, so the row and the account address each
other with no lookup table. `leagueIdBytes` throws rather than guessing — a silently wrong
id derives an account the program never wrote, which reads as a logic bug rather than bad
input.

### The web app

`apps/web`, Next.js 15 App Router. `pnpm --filter @rostr/web dev`. It needs
`DATABASE_URL` to do anything beyond render the home page.

Two things worth not undoing:

**`RulesView` renders above the join control, always, and in full.** Nothing is collapsed
behind a toggle and no field is omitted. A join button placed before the rules would make
"shown before you join" a technicality rather than a fact.

**The join message is fetched from the server, never composed on the client.** A client
that builds its own message could sign one rule set and be admitted under another.

**`/scoring` explains the point system, and is generated from `NFL_PPR_SCORING`.** Not
hand-written — a scoring explainer typed out by hand drifts the first time a value
changes and then quietly lies to users about how they are being scored. The worked
examples call `scorePlayer()` rather than stating totals, so the arithmetic on the page
cannot diverge from the arithmetic that decides matchups. **The mobile app needs the same
screen, built the same way** (commit H3b).

**Identity is email plus wallet, and the server never takes a user ID from a request.**
`currentUser()` in `apps/web/src/lib/session.ts` is the only source. The join route used
to accept a `userId` the client supplied, which meant anyone could join any league as
anyone — the wallet signature proved they held a key, but nothing tied that key to the
account being credited. If you find yourself reading an identifier out of a body, stop.

Sign-in is an emailed link. `beginEmailSignIn` handles registration and sign-in through
one path on purpose: separate routes respond differently, and the difference tells anyone
who asks whether an email has an account here. `/api/auth/request` answers identically
either way for the same reason.

**A wallet is linked by signature, never by typing an address** — `issueWalletChallenge`
then `linkWalletWithSignature`. Without the nonce, anyone could claim any address,
including one already holding a league stake. The challenge is consumed even when the
signature fails, so one nonce cannot absorb unlimited attempts.

Session tokens are stored **hashed**; the token itself lives only in the cookie. Cookies
are `httpOnly` (script cannot exfiltrate them) and `sameSite: lax` — not `strict`, because
the emailed sign-in link arrives as a top-level navigation that `strict` would reject.

`safeRedirect()` exists because `?next=` on the verify route is otherwise an open
redirect, which from a link in someone's inbox is the shape of a convincing phish.

**Rate limiting** is a **token bucket in Postgres** (`packages/db/src/rate-limit.ts`,
migration `0012`), not a counter in memory. The web app runs as serverless functions, so
an in-process counter is per-instance and an attacker gets a fresh allowance every time
the platform starts another one. Token bucket rather than a fixed window because a window
lets someone spend the whole allowance at 10:59 and the next at 11:01 — double the rate,
right where a script lands.

Two rules per endpoint, per-subject and per-address. **Both are charged even when one
refuses** — stopping at the first refusal would let someone who has already exhausted the
address bucket keep hammering a victim's account bucket for free.

`clientIp()` reads `x-forwarded-for`, which is **client-supplied and spoofable unless a
proxy we control rewrites it**. Vercel does. If this app ever moves behind something that
does not, per-address limiting silently stops working while still appearing to. The
per-account limits do not depend on it.

`hashedIp()` is **not anonymisation** and the comment says so — IPv4 is brute-forceable.
It means a leaked dump is not a readable list of member IPs. Unrelated to the rejected
IP-based sybil blocking: limiting a burst is not deciding who someone is.

**Known gaps, deliberately named rather than glossed:**

- **Login CSRF.** Someone can send you _their_ sign-in link; click it and you are in their
  account and may enter data there. Inherent to magic links, low impact, not addressed.
- **Tokens ride in URLs** and land in browser history. Mitigated by single use and a
  24-hour expiry, and the redirect drops it from the address bar.
- `revokeAllSessions()` works and is tested, but nothing in the UI calls it yet.

A managed provider (Supabase Auth, Clerk) was weighed and not taken. The dangerous parts
of auth are password hashing and OAuth flows, and there are none here — magic link plus an
opaque token is ~200 lines and 30 tests. A vendor would also split identity across their
user table and ours, exactly where wallet linking and league membership have to agree.

**Wallets:** Phantom, Solflare, and Coinbase adapters are registered explicitly, but most
wallets — including Seed Vault on Seeker — auto-register via the Wallet Standard and need
nothing. Do **not** add `@solana/wallet-adapter-wallets`: that meta-package pulls in
Ledger USB bindings, the Stellar SDK, and protobufjs, roughly 500 packages, for wallets
nobody here uses.

Migrations are not exported from `@rostr/db`'s main entry — `migrate.ts` reads SQL from
disk, which a bundler cannot statically analyse. Import from `@rostr/db/migrate` in CLI
and setup code only.

### Pinning

`pinLeagueRules()` pins the canonical bytes, **fetches them back, and re-hashes** before
returning. Never skip the read-back: a `rules_uri` resolving to anything other than the
hashed document is worse than no URI, because it looks verified.

`PinataPinningService` uses **`pinFileToIPFS`, never `pinJSONToIPFS`.** Our document is
valid JSON, so the JSON endpoint looks right — but it re-serialises server-side,
reordering keys and reformatting numbers, which changes the bytes and therefore the hash.
There is a test asserting the endpoint, so this cannot regress silently.

### League creation

`createLeague()` in `packages/db/src/leagues.ts` is the only moment a league's rules are
writable. It validates, hashes, and writes in a single transaction — so there is no state
in which a league exists with rules that were never checked, and a partial write leaves
nothing behind.

`league_rules.canonical` holds the exact bytes that were hashed, verbatim. That is what
gets pinned, and what anyone can re-hash to check against the chain. `verifyStoredRules()`
does exactly that.

The denormalised `league_scoring_rules` and `league_roster_slots` are **copies**, never
references to a shared template — a template edit must never be able to reach a league
that already exists. They carry the same immutability triggers.

### Database

Tests run on **PGlite** — real Postgres compiled to WASM, in-process, no service, no
Docker, no credentials. `createTestDatabase()` in `packages/db/src/testing.ts` gives a
fresh migrated database per test.

The real database is **Supabase** (hosted, so it follows you between machines; also
matches the stack in `percolator-launch`). Not set up yet — see
[`docs/SETUP-REQUIRED.md`](docs/SETUP-REQUIRED.md).

Migrations are **forward-only** plain SQL. There are no down migrations: a league's rules
are immutable and its history must stay auditable, so the answer to a bad migration is
another migration. Editing an already-applied file makes the runner refuse to start.

---

## Invariants — do not break these

**1. The rules hash is load-bearing.** `packages/core/src/canonical.ts` defines the only
legal encoding of a rule set. Its SHA-256 goes on-chain and members sign it when they
join. If encoding drifts, every league created before the drift stops verifying.

There is a **golden fixture test** pinning
`2e9ec043556179b82993a9febb768c9cea715bf5529b7df205d2c9503b9bc1b8`. If it fails, do
**not** update the constant to make it pass — find what changed the encoding. CI checks it
on Node 22 and 24 for exactly this reason.

**2. No floating point, anywhere near money or scoring.** Scoring is integer
**milli-points** (1 point = 1000). Percentages are **basis points** (100% = 10000).
Thresholds are explicit numerator/denominator pairs. Token amounts are decimal **strings**
(on-chain u64). `canonicalize()` throws on any non-integer, by design.

Why: passing yards score 0.04/yd. Accumulate floats across a season and matchups decided
by hundredths — which happens constantly — resolve wrong.

**3. Sports are data, never structure.** `packages/core/src/sports/nfl.ts` is the only
file permitted to name a football concept. If you find yourself writing
`if (sport === 'nfl')` or a column called `passing_yards`, the abstraction has leaked.

**4. Rules are immutable after league creation.** No commissioner override, no admin
edit, no migration that touches an existing league's rules. The only escape hatches are
unanimous consent to amend and unanimous/automatic dissolve with refunds.

**5. Paying weeks wait 7 days.** Official NFL stat corrections arrive for up to a week
after a game. Weeks 14 and 17 pay money and must finalise at T+168h. Other weeks finalise
at T+48h. Validation enforces this.

---

## Settled — do not re-open

These were discussed at length and decided. Re-proposing them wastes the owner's time.

| Decision                                         | Status                                                           |
| ------------------------------------------------ | ---------------------------------------------------------------- |
| Full PPR scoring                                 | **Settled** — table in `docs/RULES.md` §1                        |
| Schedule luck retained                           | **Settled** — median scoring was proposed and **rejected**       |
| Rolling waiver priority                          | **Settled** — FAAB proposed and **rejected** for v1              |
| NFTs _are_ the roster, not souvenirs             | **Settled** — Token-2022, transfer hook + permanent delegate     |
| NFTs persist as trophies, labelled "Player YYYY" | **Settled**                                                      |
| Trades vetoable, never automatic                 | **Settled** — 48h escrow, ⅓ of uninvolved managers               |
| Trade deadline set by the commissioner           | **Settled** 2026-08-08 — default 11; binds on the execution week |
| Rules immutable, shown before joining            | **Settled**                                                      |
| Per-game score updates, not real-time            | **Settled** — cost is not the reason; simplicity is              |
| Mainnet with the pot live for 2026               | **Settled** — risks were raised and the owner chose this         |
| Payout 60/15/10/10/5                             | **Settled** — champion must always be largest                    |
| Abandonment (3 strikes → stake forfeit)          | **Removed** 2026-08-08 — could not fire; autofill does the job   |
| Consolation bracket pays out                     | **Settled** — it is what keeps an eliminated team playing        |
| IP-based sybil blocking                          | **Rejected** — breaks households, defeated by any VPN            |
| Protocol fee: 1%, once, at settlement            | **Settled** 2026-08-07 — in the hashed rules; never on a refund  |
| Buy-in between $5 and $50 per member             | **Settled** 2026-08-07 — a range; both bounds enforced on-chain  |
| Pot mints must have six decimals (season one)    | **Settled** 2026-08-07 — what makes the $50 cap mean dollars     |
| Free leagues anchor their rules hash on-chain    | **Settled** 2026-08-07 — `initialize_free_league`                |
| Autofill on by default, per-team toggle          | **Settled** 2026-08-08 — method frozen in rules, switch is yours |
| Autofill ranks on weekly projections             | **Settled** 2026-08-08 — a decision, not a fact; see DECISIONS   |

---

## Environment

**Arriving at either machine: `git pull` then `CI=true corepack pnpm install`.** The
workspace gains packages (most recently `@rostr/escrow`) and installs platform-specific
binaries for both Windows and Linux, so a stale `node_modules` fails in ways that look
like code errors rather than a missing install.

**This repo was started on a secondary Windows PC.** Tooling installed there: Node
v24.19.0, pnpm 11.20.0, gh 2.97.0, git. No Rust, no Solana CLI, no Anchor — so **nothing
under `programs/` can be built or tested there**. `pnpm test`, `typecheck`, `lint` and the
whole TypeScript side work fine, including `@rostr/escrow`, because the IDL is committed.
`anchor test` and `pnpm idl:sync` are main-PC only.

**The main PC now has the Anchor toolchain**, so Milestones D and E are no longer blocked
by machine. Installed under WSL2/Ubuntu 26.04: Rust 1.97 (stable) alongside a pinned
1.90 default, Solana CLI 4.0.0, Anchor 0.31.1 via AVM, Node 22 via nvm. Verified by
building and testing an unrelated Anchor program against a local validator.

Five things that have each cost an hour and will cost it again:

- **Every `anchor` invocation rewrites the active Solana release** — not just
  `anchor build`, but `anchor --version` too. Anchor 0.31.1 falls back to 2.1.0, whose
  platform-tools ship rustc 1.79, too old for dependencies needing edition 2024. **This is
  now fixed by `solana_version = "4.0.0"` in `Anchor.toml`**: given a version, Anchor sets
  the active release _to that_ rather than to its own default. Do not remove that line.
  Verified by bisection — `ln -sfn` the symlink to 4.0.0, then `anchor --version`, and it
  is 2.1.0 again.
- **`/tmp` in WSL is a tmpfs, and it is RAM.** A `solana-test-validator` left running
  filled all 3.9 GB of it with a rocksdb and a 294 MB log, which surfaced as
  `agave-install` failing with "No space left on device" while `df` showed 926 GB free on
  `/`. Point test ledgers somewhere under `$HOME`, and check `pgrep -af solana-test-validator`
  before blaming the disk.
- **WSL idle-shuts-down, and `/tmp` clears with it.** Nothing that has to survive between
  commands belongs there. A long-running process is what keeps the VM alive, so the
  machine behaves differently depending on whether one happens to be running.
- **`node` is missing in non-interactive WSL shells** unless nvm is loaded from
  `~/.profile`. Ubuntu's `.bashrc` returns at line 8 for non-interactive shells, so the
  nvm block near the bottom never runs — while `cargo` and `solana` work, because those
  live in `.profile`. `anchor test` runs its `[scripts]` through exactly such a shell.
- **Node on this machine is pnpm 9 by default** while the repo pins 11.20.0. Use
  `corepack pnpm`, and set `CI=true` or pnpm refuses to purge `node_modules` with no TTY.

**One `node_modules` serves two platforms.** The TypeScript side is developed on Windows;
Anchor must run under WSL. rollup, esbuild and sharp all ship platform-specific optional
binaries, so a Windows install leaves `anchor test` dying on "Cannot find module
@rollup/rollup-linux-x64-gnu". `supportedArchitectures` in `pnpm-workspace.yaml` installs
both. Do not delete it to slim the install.

**Rust builds on `/mnt/c` are slow** — the same program takes seconds on a WSL-native path
and minutes over the 9p mount, because compilation is many-small-file I/O. Tolerable for
now; if Milestone D iteration gets painful, keep a WSL-native clone for program work.

`scripts/setup-anchor.sh` is still the right entry point on a fresh machine and is
idempotent. It does **not** yet install Node or handle the `.profile` nvm issue above.

**For Anchor work (Milestones D and E)** you need Rust, the Solana CLI, and Anchor.

On Windows this means **WSL, not native**. Anchor's build shells out to
`cargo-build-sbf`, which does not work reliably on native Windows; Anchor's own docs
point at WSL. Rust and the Solana CLI install fine either way — Anchor is the one that
does not.

```powershell
# PowerShell, AS ADMINISTRATOR. Installs WSL2 + Ubuntu. Requires a reboot.
wsl --install
```

Then, inside the Ubuntu shell:

```bash
bash scripts/setup-anchor.sh
```

That script installs build dependencies, Rust, the Solana CLI, and Anchor via AVM,
persists PATH, and generates a localnet-only keypair. It is idempotent — safe to re-run,
and safe to run on the main PC where some of it already exists.

Expect ~30–60 minutes; compiling AVM from source is the slow part.

### Getting started

```bash
pnpm install
pnpm test        # 815 tests, all green
pnpm typecheck
pnpm lint
```

---

## Conventions

- **TypeScript strict**, plus `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes`. Both are on deliberately; do not relax them.
- **`type` aliases, not `interface`**, for anything that gets hashed. Type aliases get an
  implicit index signature and so are assignable to `CanonicalValue`; interfaces are not,
  and switching would break hashing at the type level.
- **Validation returns problems, it does not throw.** A league creator should see
  everything wrong at once.
- **Commits are conventional and explain _why_.** The what is visible in the diff.
- Tests live beside their source as `*.test.ts`.

---

## Where things are

| Path                              |                                                                    |
| --------------------------------- | ------------------------------------------------------------------ |
| `docs/RULES.md`                   | The frozen league constitution. The source of truth for behaviour. |
| `docs/DATA-MODEL.md`              | Sport-agnostic schema                                              |
| `docs/LIVE-SCORING.md`            | Update strategy, automation jobs, provider costs                   |
| `docs/BUILD-PLAN.md`              | Milestones and commits, deadline-ordered                           |
| `docs/DECISIONS.md`               | Why things are the way they are, including rejected options        |
| `packages/core/src/canonical.ts`  | Canonical encoding + hashing. Highest-stakes file.                 |
| `packages/core/src/sports/nfl.ts` | The only file that names football concepts                         |
| `packages/core/src/rules/`        | Rule schema, NFL PPR defaults, hashing, validation                 |

---

## Answering a scoring question: verify all three sources

**Standing rule from the owner.** Any question of the form "does X score?" or "how many
points is Y?" gets answered from three places, never from memory:

1. **Tank01** — is the stat actually obtainable, and under what field or text form? Use
   `stats:probe`, `verify`, `discover`, `deep`. Field names guessed from documentation
   have been wrong three times already.
2. **ESPN** — what do they pay, and is it on by default?
3. **Sleeper** — same, and note their category structure. They split "Special Teams
   Player" from "Special Teams Defense", which is the distinction that stopped return
   touchdowns being double-counted.

Answering from any one of the three has produced a wrong answer at least once. The
scoring table is frozen per league and decides who gets paid, so "probably 6 points" is
not good enough.

Record the finding in [`docs/TANK01.md`](docs/TANK01.md) with the verbatim strings, so
the next person does not repeat the lookup.

---

## Working with the owner

Preferences established in practice, not stated as rules:

- **Website before mobile.** The Seeker app matters, but the web app is the priority for
  2026; mobile is Milestone H and off the critical path.
- **Flag risks once, clearly, then build what was asked.** Concerns about the mainnet pot,
  the audit timeline, and winner-take-all were each raised and each answered. They are
  decided — see the settled table below. Re-raising them is noise.
- **Keep notes in the repo, not in a chat window.** This file, `DECISIONS.md`, and
  `SETUP-REQUIRED.md` exist because the owner works across two machines and expects to
  pick up where they left off. Update them as you go rather than at the end.
- **Say what is not done.** The scoring fixtures are constructed rather than real box
  scores, and that is labelled everywhere it appears rather than glossed.

**There are more product ideas the owner has not yet shared.** They said so explicitly
during the initial scoping and the conversation moved on to building. Worth asking before
assuming the current spec is the whole product.

---

## Blocked on the owner

**[`docs/SETUP-REQUIRED.md`](docs/SETUP-REQUIRED.md) is the live list** — accounts, API
keys, and decisions only the owner can supply, each recording what it blocks and when it
is needed. Keep it updated: when you hit something that needs a credential or a call the
owner has to make, add it there rather than stalling or guessing.

Nothing on that list blocks `pnpm test`. The core is deliberately testable without a
single credential.

The two that matter most right now:

- **The escrow audit** — 2–4 weeks of calendar time, gates pot leagues opening on Aug 22.
  Should be quoted _now_, before the program is finished.
- **Bot draft sophistication** — a scope decision needed before Milestone B.
