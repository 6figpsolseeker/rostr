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

**Done — 1222 tests, CI green:**

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

- B6–B7: Tank01 adapter and the box-score **translator** (`packages/stats/`). **B8 is
  partial**: players, byes, rankings, projections and now the schedule sync; there is
  still **no box-score producer**, so `stat_lines` is empty and `getBoxScore` has no
  caller. See issue #75 — "live sync" was listed as done here and was not.

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

**Aug 22 is covered in code — create → join → draft. Sep 9 is not, and this paragraph
used to say it was.**

The sentence here read "Both hard deadlines are now covered in code… what they need is
deployment and the credentials in `SETUP-REQUIRED.md`, not more code." That was false, and
it is the most expensive kind of false: it is the sentence that stops someone looking.

What was missing (issue #75): **nothing wrote `stat_lines` and nothing called `syncGames`.**
`getBoxScore` had no caller outside its own interface and a test stub. So on a real
deployment `games` was empty, `weekHasSchedule` was false, and **no manager could set a
lineup at all** — `setLineup` refuses with `SCHEDULE_MISSING`. `currentWeek` was null, so
`/api/cron/score-week` returned `{week: null, leagues: []}` and had been a no-op every ten
minutes since it shipped. And with `games` hand-populated but no stat lines, every week
would have finalised **0–0, permanently**, because a finalised week is never rescored.

`docs/LIVE-SCORING.md` describes six automation jobs in the present tense and only one of
them exists. Reading a plan as a description is how the claim above got written.

**Now:** `syncGames` is wired into `pnpm db:sync` and the schedule is real. **Still
outstanding:** `syncBoxScores` does not exist, so `stat_lines` is still empty and every
player still scores zero. Sep 9 is not covered until that lands, and the adapter defects in
issue #81 — which are latent only because nothing calls `getBoxScore` — become live the
moment it does.

- **Anchoring wired into the app** — `POST /api/leagues/[id]/anchor`, `AnchorPanel.tsx`,
  and `readOnlyEscrow()` in `apps/web/src/lib/escrow.ts`. The commissioner signs from
  their own wallet (decided 2026-08-07), so no private key of ours exists anywhere.

  **The route does not take the client's word for it.** A signature proves _some_
  transaction happened, not which, so it reads the account back and refuses unless the
  chain agrees with the signed rules. Three 409s, deliberately different: `NOT_FOUND`
  means retry; `HASH_MISMATCH` means the chain holds a different rule set; `TERMS_MISMATCH`
  means the hash matches but the money does not. The last two are not retries — they are
  leagues nobody should join.

  **A matching hash is not enough, and that is the whole of PR #32.** The program stores
  the economic terms as a separate copy it has no way to check against the hash, so a
  creator can anchor the exact document members sign while initialising a hostile buy-in,
  fee recipient, payout split or `refund_unlock_at`. The last is the worst: `refund_stake`
  is the only way tokens leave the vault and it requires the clock to have passed, so a
  far-future value freezes every deposit permanently, and the program permits it — its
  only check is that the value is in the future.

  Two things about this check are load-bearing. **It re-runs on an already-anchored
  league** rather than returning early on the stored boolean, because nothing else in the
  system ever reads the account again and a league recorded before the check existed would
  otherwise be trusted forever. And **a false positive is unrecoverable** — no setter, no
  `close`, the PDA derived from the league's UUID — so a wrongly refused league can never
  be anchored, only recreated under a new id. That is why the fee recipient is compared
  only when a fee is actually charged: fee-free leagues legitimately carry an empty one.

  `expectedTermsFromRules` and `anchorTermMismatches` live in `@rostr/escrow`, not in the
  route, because **`apps/web` cannot test React** — a mapping inline in a component is
  verified only by being run in production, and both defects found in review were in the
  mapping rather than the comparison.

  **Corrected 2026-08-12: `apps/web` does have a test project**, and this sentence used to
  say it did not. The root `vitest.config.ts` collects `apps/web/src/**/*.test.ts` (so
  `pnpm test` runs them) and `vitest.web.config.ts` runs them alone as `pnpm test:web`.
  Five files live there today. What is still true is the narrower claim: both configs are
  node-environment and the glob is `.ts`, with no jsdom and no testing-library, so a
  **component** cannot be rendered in a test. Server-side helpers under
  `apps/web/src/lib/` are testable and should be tested — `lib/cluster.test.ts` and
  `lib/pot.test.ts` are the pattern, using `vi.stubEnv` and needing no database.

  Verified end to end against a real validator, not reasoned about — see
  `programs/rostr-escrow/tests/anchor.test.ts` below.

- **C12 finished — the scoreboard** (`packages/db/src/matchup.ts`,
  `apps/web/src/components/Scoreboard.tsx`). The standings half had shipped and the
  matchup half had not, so there was no screen answering "who am I playing and am I
  winning" — the one people actually open on a Sunday. See "The scoreboard" below for the
  two rules that are load-bearing.

### Outside review, 2026-08-10 — read this before touching the PR queue

Two outside reviewers have opened PRs. **They are not the same kind of contribution and
should not be treated the same way.**

**0x-SquidSol.** Seven PRs merged (#3, #5, #8, #10, #12, #14, #16), each followed by a fix
of our own on top. Four more — **#32, #34, #36, #38 — all now closed**, each superseded by
our own version of the same fix. They are kept below because the _diagnoses_ are the
record: every one named a bug that was live on `main` when it was filed, and the pattern
of what they found is worth more than their status. Verified individually on 2026-08-10:

- **#32** — `verifyLeagueAnchor` compares `rulesHash` and nothing else. `OnChainLeague` does
  not even expose `refundUnlockAt`, `feeRecipient` or `payoutBps`, so three of the economic
  terms cannot be checked at all. The commissioner signs `initialize_league` from their own
  wallet, so they choose the account's terms independently of the document members sign — a
  hostile `refund_unlock_at` leaves every deposit permanently stuck. **This is the one with
  money at stake.**
- **#34 — FIXED**, see "The bracket waits for final" below. `loadWeekResults` filtered
  `home_milli_points IS NOT NULL`, never `finalized_at`,
  so the bracket advances and `championship()` crowns from provisional scores.
- **#36** — `acceptTrade` checks state and receiver only. Two proposals can name the same
  player, and `resolveTrade` inserts him onto both receivers unconditionally. The
  `(team_id, player_id)` unique index is per-team and does not stop it.
- **#38 — FIXED**, see "One league's failure never stops the others" below.
  `BracketError extends Error`, not `PlayoffError`, so the score-week cron's guard
  rethrows it and one undersized league aborts scoring for every league.

**Three of those four are bugs in code written in this repo the same week** (#34 and #38 in
the playoff work, #36 in trades). Squid's diagnoses have been right every time. The lesson
that outlasted the PRs: **a correct diagnosis and a correct fix are separate questions**,
and on this repo the second has needed our own work every time — which is why each of the
four was closed in favour of a version written here rather than merged as sent.

**vip-ultr (Ammar).** Three PRs. **Two are now merged**, each as a follow-up built on his
commit rather than a replacement, so his authorship is in `main`. His diagnoses have been
right every time — `join_league` genuinely was never invoked, and deposit/refund genuinely
had no callers — but the implementations needed substantial work, and in both cases the
defect was in a _verifier_ rather than in the wiring.

- **#29 — closed**, superseded by #39 and then #63, **merged 2026-08-11**. Reviewed by three agents
  under separate mandates (security / state-machine / conformance). Four defects, all
  confirmed by reading the code: the route took `walletAddress` from the request body with
  no ownership check; a comment claimed a Postgres membership check that was actually a
  `getLeagueRules` call; `verifyOnChainJoin` compared a key against a PDA derived from that
  same key, so `MEMBER_MISMATCH` could never fire while its docstring claimed the opposite;
  and the retry re-sent an `init` instruction that cannot succeed twice.
- **#30 — closed**, superseded by #62, **merged 2026-08-11**. `verifyOnChainRefund` was
  **inverted** and `verifyOnChainDeposit` never consulted `refunded` at all. See "Deposit and
  refund: `deposited > 0` is not currently staked" below for the four `Membership` states and
  why reading one field could never have been enough.
- **#31 — closed 2026-08-14**, reviewed at last. It added `settle_authority` to the
  `League` account and an instruction where that authority posts the winners. Two findings,
  either sufficient on its own:

  **`settle_authority` was written and never read.** Assigned at `initialize_league`,
  declared on the account, used as the rent `payer` and as a `Signer` — and never compared
  to anything. No `has_one`, no constraint, nowhere in the program. So
  `post_final_standings` accepted **any** keypair, and `payout_fee` and `payout_prize` had
  no `Signer` field at all. Since `join_league` is permissionless (issue #18), anyone could
  take a seat for rent, name themselves in all five prize slots, and drain the vault once
  members deposited. `standings` is `init` with no `close`, so the first caller froze the
  winners permanently — a stranger could make any pot league unsettleable for the price of
  rent.

  **It killed the timelock refund**, without touching it. `payout_prize` zeroes
  `league.total_deposited`, so a later `refund_stake` underflows on `checked_sub`; and
  `payout_fee` decrements nothing, so after a fee-only drain the last member's transfer
  fails against an under-funded vault forever. The unconditional refund is what makes
  shipping before an audit defensible, and this removed it from the outside.

  **And the design was wrong even fixed.** `RULES.md` §7 — rendered above the join control,
  its hash signed by every member — says "No one declares a winner… no commissioner
  sign-off, no vote, and no discretion." A settle authority makes that false for people who
  already signed it. The calendar does not force it either: the first money movement is the
  Week 14 prize on 13 Dec, the timelock refund already works, and the derived path is D6
  behind the G4–G8 oracle, scheduled for exactly that window.

  Issue **#28 stays open** — the diagnosis was right, and the program does need a payout
  path. The piece worth building is **G7**, finalised scores on-chain; `championship()`
  already derives all five prize-holders in TypeScript with no stored winner.

**A pattern worth naming, because it recurs across both reviewers and across our own work:**
several of these PRs ship a comment asserting a guarantee the code does not provide. This
repo treats comments as specification, so a false comment is a defect in its own right —
review them as such, and fix the comment before arguing about the code.

**Two program-level problems surfaced that no PR fixes.** One is **fixed**; the other
still needs Rust and a decision before Aug 22:

- **Seat-squatting (issue #18).** `join_league` is permissionless and there is no eviction
  instruction, so throwaway keypairs can fill a league's seats for a fraction of a SOL and
  permanently block every real member's deposit. Found independently by Squid and by an
  adversarial review of #29. It predates everything here; wiring the app to `join_league` is
  what makes it reachable.
- **The browser defaulted to mainnet — FIXED**, see "One declaration of which chain"
  below. Three independent sources of "which chain", no cross-check, and the most
  dangerous default sitting on the one that signs.

**Next, in order:**

0. **The PR queue is empty as of 2026-08-14**, for the first time since it formed. Sixteen
   PRs landed in one pass and `main` is green on both CI and Anchor. Squid's four and
   Ammar's three are all resolved — merged, superseded, or reviewed and closed.

   **Two things that made the queue expensive, so they do not recur.** It had gone
   unmerged since 2026-08-11 while growing to nineteen, and by then it contained the same
   fix twice, twice: #85 duplicated #88 and #86 duplicated #89, from the two machines. It
   also contained two migrations at `0025`, which would have failed every database-backed
   test on `main` the moment both merged. **Land work sooner; a queue this deep is where
   both of those came from.** Migration numbering now has a CI guard and `main` requires
   branches to be up to date, so the second cannot happen silently again.

   **`anchor test` is not a reason to defer a PR.** `.github/workflows/anchor.yml` runs it
   on CI for anything touching `programs/**`, `Anchor.toml`, `Cargo.*` or
   `vitest.program.config.ts` — it installs Solana and Anchor, builds, deploys to a
   validator, runs the program suite, and checks the IDL and program id. Only running it
   _locally_ needs the main PC. This file said otherwise for days and it cost real time:
   #39 sat open waiting for a machine when opening a PR would have answered it in four
   minutes. **CI earned that keep on 2026-08-11** — it caught a genuine failure in
   `stake.test.ts` that no TypeScript check could have.

1. **Click through create → anchor → join in a browser.** Everything either side of the
   wallet popup is covered by an automated test; the popup itself is not, and cannot be
   from here. This is the one step that needs a human with Phantom.

2. **D6–D10** — the rest of the escrow. **Writing Rust needs the main PC** (no toolchain on
   the secondary machine), but _verifying_ it does not: CI builds and tests the program on
   every PR, so an iteration loop of push-and-read-CI works from anywhere, at roughly four
   minutes a turn. Note that **D6 is not a small job**: "payout by the frozen split"
   needs to know who won, and `RULES.md` § 7 says nobody declares a winner — the contract
   derives it from posted scores. That makes D6 depend on G4–G8 (dual-source oracle, scores
   on-chain), which the build plan schedules for Dec–Jan. Do not start D6 expecting an
   afternoon.
3. **Pot leagues must not take money on mainnet** until D6 can pay it back out — and that
   is now enforced rather than remembered. Anchor → join → deposit → timelock refund all
   work end to end and are exercised against a validator on every CI run (#62, #63), so
   the structural barrier is gone: money can go in and come back out through the
   unconditional refund, but it cannot be _distributed_. What closes the gap is
   `potDepositGate`, which shuts the stake button on mainnet until the committed IDL
   carries a settlement instruction. See "Deposit and refund" below.

   The missing piece is the payout (#28, D6). PR #31 offered one and was closed on
   2026-08-14 — see the review above; the short version is that it declared a winner,
   which `RULES.md` §7 forbids, and its authority field was never actually enforced.

4. **Settlement**, which is where the season ends up. `championship()` now derives all
   five prize-holders from the scores; nothing pays them out yet, and that is D6 — see
   above for why it is not an afternoon.
5. **B5's outstanding half — validate scoring against real 2025 box scores.** The engine
   is still checked only against _constructed_ fixtures, and it decides who gets paid. The
   Tank01 key is provisioned but lives on the main PC, so this is **main-PC work** despite
   needing no Rust. Hand-verify a handful of real games against ESPN's totals and record
   them in `docs/TANK01.md`. Worth doing before Sep 9 rather than after.

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

**A failed lookup is not a skipped slot, and conflating them moved the draw** (issue
#20). `rpc()` used to collapse a transport error, an HTTP 429/500, and a JSON-RPC error
body into one code, and `blockTime` read all three as "this slot was skipped" — so one
transient fault on the boundary slot silently settled the search one block late. The
draw is written once, the trigger freezes it, and `verify()` then reports the league's
own recorded order as wrong forever. `blockTime` now returns `null` **only** for a
recognised "no block there" answer — a JSON-RPC `-32007`/`-32009`, a `null` result
that is actually **present** in the body, or a message saying _skipped_ **on a code in
the same -3200x family** — and throws on everything else. Both narrowings are load-bearing
and were found by review, not design: an absent `result` and `result: null` both read as
`undefined`, so collapsing them let a bare `{"jsonrpc":"2.0","id":1}` from a proxy pass
as a gap; and an ungated message check reads `{code: -32603, message: "…was skipped by
the proxy"}` as a gap too. **Fail closed:** an
unrecognised error is a failure, not a gap. That direction is deliberate, because
refusing costs a retry (the block is fetched outside the transaction, so a throw writes
nothing, and the answer is deterministic once the block exists) while guessing costs the
league its verifiability. The exact wire format for a skipped slot has **not** been
checked against a live node — see the comment on `SKIPPED_SLOT_CODES`, which says so.

`verify()` throws for the same reason instead of answering `false`. Its `false` is
published as "this league's order was rigged", and a 429 during an audit must not be
able to say that.

Each RPC call gets **three attempts** with a 200ms doubling backoff, on 429, on 5xx, and
on a _transient JSON-RPC error body_ — `-32004`/`-32014` (a load-balanced backend a few
slots behind the one `getSlot` answered from) or a provider that delivers a rate limit as
HTTP 200 with the limit in the body. That last shape is not a thrown error, so it
originally bypassed the retry loop entirely — the retry never fired for the case it was
added for. ~30 unpaced sequential calls at a free public endpoint will meet a rate limit
eventually, and now that a rate limit fails the draw rather than being swallowed, one in
thirty would send the commissioner back to the button. Pacing was rejected: it slows
every draw to absorb a burst three attempts already handles, and each call is an
idempotent read of immutable history.

`FixedBeacon` is test-only. It makes the seed predictable, which is the entire thing the
real one exists to prevent.

**Persistence lives in `packages/db/src/draft.ts` and adds exactly one thing the engine
cannot do: arbitration.** The engine is pure and single-threaded, so when two managers
click at the same instant both read "pick 15 is open", both validate, and both are right.
The database decides instead — `SELECT ... FOR UPDATE` on the draft row is the fast path,
and `PRIMARY KEY (draft_id, pick_number)` plus `UNIQUE (draft_id, player_id)` are the
backstop if anything ever writes outside that lock. Both are tested.

**Serialising is not the same as being right**, and issue #22 was the cost of assuming it
is. The lock decides who writes first; it cannot make a decision taken before the lock true
afterwards, and two callers who both read "pick 15 is open" are queued and then _both_
write — legal rows, different pick numbers, different players, so no constraint fires. What
catches it is re-reading the decision inside the lock. See "The draft room".

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

**And read from one source — `PRIMARY_PROJECTION_SOURCE`.** `player_projections` is keyed
on `(player, season, week, source, stat_key)` so a second opinion never overwrites the
first, and `scorePlayer` folds over every row — so an unfiltered read projects a
dual-covered player at roughly double and leaves single-covered players alone. That is a
reordering, and the ranking is what decides who starts. It reaches every manager, not only
abandoned teams: `autofill_enabled` defaults to true and the autofill also fills gaps in a
hand-set lineup.

**It is a separate constant from `PRIMARY_STAT_SOURCE`, on purpose.** One vendor satisfies
both today, but the choices have opposite drivers: a stats source is picked for factual
accuracy under §7's two-provider agreement gate, and a projections source is picked for
model quality and is _exempt_ from that gate — §7 says a projection is an opinion, and
opinions cannot pass an agreement test. Coupled, swapping the stats oracle would silently
re-rank every autolineup.

`loadProjections` used to default to _every_ source (`COALESCE($3, p.source)`), and the
draft board is its only caller and omitted the argument — so the board would have doubled
too. An optional filter defaulting to "all" is not a filter.

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

**`catchUpExpiredPicks()` runs on every read of the draft**, as well as on the cron tick.
That is how clocks expire. It is safe to run from anywhere, any number of times at once —
but **it is not safe because the picks are deterministic**, and that is what the comments
here used to claim (issue #22).

Every caller decides "pick N is overdue" from a read taken _before_ the lock. `FOR UPDATE`
then queues them and each writes in turn, so N stale callers made N _consecutive_ picks:
pick N legitimately, then N+1 and N+2 for managers who had just been handed a full ninety
seconds. Nothing catches that afterwards — the rows are different pick numbers and
different players, so the primary key and the unique index are both satisfied, there is no
un-pick, and `createDraftRecord` refuses a redraft. Anyone who knew a league id could
amplify it, because the read route needs no session.

**So `recordPick` re-checks the decision inside the lock: the expected pick number _and_
the deadline.** Two guards, and neither replaces the other — the pick number catches a
snapshot that predates somebody else's pick, the deadline catches a pause-and-resume,
where the pick on the clock is unchanged and the timer is new.

**Losing that race is a no-op, not a throw.** `catchUpExpiredPicks` returns how many picks
it made itself. The draft read route catches only `DraftContextError`, so an error there is a
500 in a polling tab at the exact instant the draft advances.

Each auto-pick is stamped **at the deadline it missed, not at `now`**, and that is
load-bearing. Stamping `now` restarts the next manager's clock from whenever somebody
happened to open the page: an hour of nobody watching would cost exactly one pick and
silently extend every clock after it. Advancing deadline by deadline keeps the draft on
real time. Tested.

**And a manual pick that arrives after its own deadline is refused** (`CLOCK_EXPIRED`,
409), not accepted and stamped `now`. It used to be accepted: `makePick` checks the turn
and not the clock, so five managers each a minute late pushed the draft 300 seconds behind
the schedule it published, one overrun at a time, added to a baseline that never
re-anchors. That is precisely the drift the deadline-stamped auto-pick exists to prevent,
and it is not less drift for having a human behind it. The room disables the Draft button
when the countdown reads 0:00 — `DraftRoom` owns the deadline for that reason, so the
countdown and the button share one deadline. They run on separate timers so they can
differ for up to 250ms, but not about _which_ instant is the deadline. The button is a
courtesy and the server is the rule.

**That gate is measured against the server's clock, which the draft payload carries as
`now`.** Measuring it against `Date.now()` reads correctly on a correct machine and locks
a wrong one out of the entire draft: a browser more than one pick clock fast computes
every deadline as already passed, disables its own Draft button on every poll, and
auto-picks every round. Only the _elapsed_-time half of the local clock is used, for the
timeout, and that stays accurate however wrong the absolute time is. A UI that refuses a
pick the server would have accepted is worse than the drift this gate exists to prevent.

**Open, and an owner's call, not a bug:** in a 24-hour slow draft a pick a minute late is
refused for a drift of one minute in twenty-four hours. Defensible and harsh. A grace
period in SLOW mode would be a reasonable alternative and was deliberately _not_ invented
here.

**`/api/cron/draft-tick` is what makes clocks real.** Before it existed, expiry happened
only when somebody _read_ a draft, so a draft nobody had open did not advance and a
manager who went to bed could return to find their clock had never run. It must fire **at
least as often as the shortest pick clock** — a minute, given the 90-second minimum.
`apps/web/vercel.json` schedules it; anywhere else, point cron at the URL.

Set `CRON_SECRET` to stop it being hammered. It is not a security boundary in the usual
sense: the endpoint only does what the clock already permits, so an unauthorised call
cannot produce a wrong pick. The guard is about database load. **That holds because of the
two guards above** — before them, hammering it at a real expiry produced extra picks, and
the public read route did the same work anyway, so the secret was never what prevented it.

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

There was a **third** case that did look like an oversight and was one: an **unknown**
player never locked either. `isSlotLocked` read the kickoff out of the roster map, and
`roster.get(id)?.kickoffAt` answered `undefined` both for a bye and for a player who was
not in the map — so cutting the man in a locked slot deleted the lock with him. It now
**fails closed**: an unknown player locks.

**The lock no longer consults a roster at all.** It takes `KickoffTimes` — player id to
kickoff — built over the union of the roster and whoever is standing in the stored lineup.
A lock is a fact about a game that has started; who owns the player is a different
question, answered by the same map that answers `NOT_ON_ROSTER`. Conflating them is what
made the lock defeasible. **Do not widen `loadRosterForWeek` to fix a lock** — that map is
`validateLineup`'s ownership oracle, and widening it would let a manager start a player he
had cut, put released players in the autofill's candidate pool, and offer them in the
editor.

A locked slot may **keep** its player; it may not change. Rejecting the slot outright
would make submitting a whole lineup on Sunday fail because of a Thursday slot the
manager can do nothing about. It may not be **emptied** either, or the empty-slot rule
above would become the bypass instead — there is a test.

**`RULES.md` §6 is now implemented, and it had never been.** _"A player cannot be added or
dropped once his own game has kicked off. Otherwise a manager could cut an injured player
mid-game, or add one after his touchdown."_ Members signed that and nothing enforced it.
`dropPlayer` and `addFreeAgent` now refuse with `GAME_STARTED`.

The two release paths that **cannot** refuse are left alone deliberately: a throw inside
`processWaivers` rolls back the whole league's run and leaves the claim PENDING forever,
and `resolveTrade` cannot undo a trade the league already approved because a game started.
Those are covered by the lock instead, which holds however the player left. Closing the
route and closing the outcome are different jobs and this needs both — the same argument
`ASSET_GONE` makes for trades.

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

That last sentence used to be true and useless: the screen and the server both computed
the lock from a roster map that had already lost the player, so they agreed and were both
wrong. `loadKickoffs` is now the one definition of when a player locks, and the lineup
route asks it the same question `setLineup` does.

**`autoFillLineup` evicts a player who left the roster before his kickoff.** He is a hole,
not a choice the manager made — and leaving him let his slot lock at kickoff around a
player nobody rosters, who then scored for the team that cut him. Note the `lockedAssignments`
call there was dead code before this: it is a strict subset of the loop below it, since a
null player never locks, so it never kept a slot the second loop would not have kept anyway.

`ensureLineups` is what makes `resolveWeek`'s precondition true. That function throws when
a scheduled team has no lineup, deliberately — scoring a missing team as zero hands its
opponent a free win — so the autolineup fills every gap before a week is scored.

### Scoring and finalising a week

`packages/db/src/week.ts`, run by `/api/cron/score-week`. The persistence and job half;
the pure arithmetic is "Resolving a week" further down.

**Scoring and finalising are separate decisions.** Points are rewritten on every run so a
manager can watch their week; `finalized_at` is set once the correction window has elapsed,
and, _within_ that window, only when every game is `FINAL`. A finalised week is never
rescored — in a paying week it has already decided money, and a silently changed result
afterwards is exactly what the window exists to prevent.

**And that is enforced on the write, not by the check above it** (issue #76). `ALREADY_FINAL`
reads `count(*)` in its own autocommit statement and the `UPDATE` runs four round trips later
— `ensureLineups` alone opens a transaction of its own — so two overlapping runs both read
zero and the slower one wrote its older stat snapshot over the settled row. Nothing recorded
it: `finalized_at = CASE … ELSE finalized_at END` kept the timestamp, and the sweep's
`NOT EXISTS` selection means the guard that failed to prevent the write is the same guard
that prevents the repair. There is no winner column, so the overwrite flips `winnerOf` and
everything seeded from it.

`AND finalized_at IS NULL` on the `UPDATE` is what closes it, and it has to be _in the
statement_: at READ COMMITTED the loser blocks on the row lock, wakes when the winner
commits, and re-evaluates that WHERE against the committed row. Which is also why there is
no `FOR UPDATE` here — serialising the two runs would only queue the loser up to write its
stale numbers in turn. The lock decides who writes first; it cannot make a decision taken
before the lock true afterwards.

**Refused everything throws; refused _some_ reports.** A run that matched no rows raises
`ALREADY_FINAL`, and the rollback discards nothing because nothing was written. A week can
also hold a settled row beside an open one, and there the run legitimately writes the open
one — throwing would roll back a real write that nothing would ever retry. That case says so
in `matchupsAlreadyFinal`, and `matchups` counts rows written rather than results scored.
The count is only knowable because the statement ends in `RETURNING id`: `PostgresClient.query`
returns `rows` and discards `rowCount`, so a refused write was not merely ignored, it was
unobservable.

The window comes from the rules: 48 hours normally, **168 for weeks 14 and 17**, because
official NFL stat corrections arrive for up to seven days.

**The window is a ceiling on the wait, not only a floor.** "Every game is `FINAL`" cannot be
a standing precondition, because a postponed or abandoned game never becomes `FINAL` — one
of them would hold a week open forever, and weeks 14 and 17 would never settle. `RULES.md`
§10 answers that in advance ("affected players score 0 for that week; the matchup stands"),
and the scoring window it names is the one `finalizationHours` already computes, so the
fallback needs no new rule field and cannot move the golden hash.

**"Affected players score 0" needed no code.** A player whose game was never ingested has no
stat line, and `results.ts` already scores an absent line as zero. Letting the week finalise
_was_ the whole implementation — everything else in that sentence was already true.

A week that settles this way says so, in `finalizedWithUnfinishedGames` on
`ResolveWeekOutcome`, which `/api/cron/score-week` surfaces. **Do not collapse it into
`finalized: true`.** Settling on complete data and settling because the clock ran out are
different facts, and only the second is worth waking someone for: those games are now scored
as they stand, permanently, because a finalised week is never rescored. The cost when the
feed was merely slow is one game's stats — the same trade the correction window already
makes against a stat line arriving at T+49h.

Scores read `stat_lines_current`, so a correction that arrived as a new revision is used
and the superseded one is not. There is a test for that specifically.

**And from one source — `PRIMARY_STAT_SOURCE`.** The view keys on `source` as well as
revision, so two providers reporting the same stat are two rows and `scorePlayer` folds over
both. Unfiltered, every shared stat counted twice — and only for the players both providers
covered, so the distortion was uneven and reordered the autolineup rather than merely
inflating scores. A revision only supersedes _within_ a source, so a correction would have
added rather than replaced.

**Filtering at read time is not the same as ignoring the second provider, and the difference
is the point.** `RULES.md` §7 requires two independent sources to agree before a paying week
finalises, and the view is the only place their values sit side by side. Collapsing them in
the view or averaging them away would delete that comparison at the storage layer and have
to be undone to ship G4/G5. There is a test asserting both rows survive.

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

Two properties of `processWaivers` are load-bearing: it is **blind** (no team's outcome
depends on when another team filed — priority decides every contest between teams, and
submission time only orders a team's own claims against each other) and **replayable**
(pure, so a disputed run can be re-run rather than argued about). Both come from
`resolveWaiverClaims`; do not reimplement them here.

This used to say the resolution could not depend on submission order **at all**, and the
code never did that either: one team's two claims tie on priority and fell through to
`claimId`, a v4 UUID. A coin flip chose which of a team's own claims was tried first — and
therefore which player was left on the board for the next team down, so it moved outcomes
**across** teams, not merely within one. `created_at` is deliberately left to the database
rather than written from `input.now`: now that it decides who gets a player, a caller-
settable submission time would be a way to file a claim and then move it to the front of
your own queue.

**ESPN, Sleeper and Yahoo all let a manager rank their own pending claims** — ESPN's
_Pending Moves_ panel says "Reorder claims by dragging them into your preferred priority".
Filing order is an _approximation_ of that, not conformance with it, and the app shows the
order without labelling it. The explicit rank is separate work; do not describe the current
behaviour as matching ESPN.

Priority is seeded at draft completion, reversed from the draft order. Winners move to the
back, losers do not move at all — a failed claim costs nothing, so there is no reason to
hoard claims.

**Watch the clock in tests.** A player dropped Monday afternoon clears at Wednesday 03:00
**Eastern**, which is 07:00 UTC — so a test using "Wednesday 18:00 UTC" is _after_ the
clear, not before it. One test asserted the opposite and was wrong.

**"A week ago" is not `now - 7 * 24h`, and use `latestWeekly` rather than writing it
again.** Consecutive weekly moments are 169 hours apart across the November fall-back and
167 across the spring change — a week of _local days_, which is the entire reason the rules
carry a weekday and an hour instead of an offset. Both `everyoneIsOnWaivers` and
`transactionWeek` used to find the most recent lock by asking the strictly-after
`nextWeekly` from exactly 168 hours back, which lands _on_ the previous lock and is then
skipped, so for the hour of **Monday 2 November 2026, 23:00–23:59 ET** they answered with a
lock in the future: free agency closed early, and `transactionWeek` named week 10 while week
9's Monday night game was being played — which sends §6's kickoff lock to look up games that
have not started, during the one game it most needs to refuse. The spring change had the
mirror of it. `latestWeekly` walks instead of assuming an interval, and assumes nothing about
how long a week is.

### The bracket

`packages/core/src/season/bracket.ts` (pure), `packages/db/src/playoffs.ts` (state),
laid by `/api/cron/score-week`, drawn at `/leagues/[id]/bracket`.

**A bracket is a function of the field and the scores, recomputed every time.**
`buildBracket` walks from round one on each call; nothing stores who advanced. That is
what makes a Week 15 stat correction reshape Week 16 with no leftover "winner" row
disagreeing with the score it came from. At this size the recomputation is free, and in a
pot league the bracket decides who is paid — so it has to be reproducible by anyone
holding the same inputs.

**Every round reseeds.** Best surviving seed against worst. So the top seed's Week 16
opponent depends on who won in Week 15, which is why fixtures are written one round at a
time and why the screen shows no future rounds. A greyed-out Week 16 fixture would be an
invention.

**The higher seed wins a tie.** `winnerOf` in `results.ts` answers `null` for equal
totals, which is right for the regular season — a tie is a real outcome there. A bracket
cannot have one. `decidedBySeed` is on the game so the screen can say so rather than
letting it look like an ordinary win.

**A bye gets no matchup row at all**, unlike a regular-season bye. A row would put a
lineup requirement on a team that is not playing, and `ensureLineups` would dutifully fill
one.

**`loadWeekResults` filters on `phase`, defaulting to `REGULAR`.** It did not before, and
that was a live bug waiting for Week 15: seeds come from the regular season, so a bracket
game counting toward a record would move the seeds the bracket was built from, and the
standings would chase the results they produced.

**A bracket plays the _last_ weeks of its window, not the first.** A four-team consolation
bracket in a three-week window plays 16 and 17 — it must finish in the championship week,
because that is the week the payout settles.

**`championship()` derives all five prize-holders from the scores.** There is no column
holding a champion and no endpoint that sets one; `docs/RULES.md` §7 says the result is
derived, and a stored winner is a value somebody could be persuaded to change. This is
what D6 will read.

Fixtures are laid **before** scoring in the cron, not after: Week 15 has no matchups until
`advancePlayoffs` writes them and `resolveLeagueWeek` refuses a week with no schedule, so
the other order would cost a full cycle every time a round turns over.

### The bracket waits for final, and the sweep is what makes final happen

`bracketFor` reads **finalised** results only, so a round advances and the champion is
derived from a settled score — never a live one, a 0-0 before kickoff, or one inside the
correction window. `championship()` also asks for finalised **seeding**, because the best
regular-season record is a paid prize (1000 bps) and Week 14 is a 168h week: every game is
final on the Monday and a correction can flip the holder for another seven days. The
standings screen deliberately keeps the live read — that table is meant to move.

**The two halves are one change.** Requiring finalised results without the sweep would
leave the champion permanently underivable: the cron resolved only the pointer week, and
week 17's 168h window closes _after_ week-18 games move the pointer off it. Week 14 is
abandoned the same way, four days early, by week 15's Thursday game.

Three properties of `resolveLeagueWeeksThrough` are load-bearing, and each was wrong first:

- **A week that throws is recorded and the sweep continues.** Without it, one old
  unresolvable week blocks every later week for that league on every run — worse than the
  bug being fixed, since before the sweep a broken week 3 could not stop week 16 scoring.
- **Selection and refusal must be complements.** The sweep picks weeks where _no_ row is
  finalised; `resolveLeagueWeek` refuses weeks where _any_ row is. Selecting on "any row
  unfinalised" makes a mixed week both guaranteed to be selected and guaranteed to throw.
  That state is reachable — a smaller consolation bracket starts in a _later_ week, so a
  week can finalise holding only consolation fixtures and then receive playoff ones.
- **It is bounded** (`SWEEP_LIMIT`), most-recent-first, and says what it deferred. A tail of
  never-finalisable weeks would otherwise re-run the full lineup-and-scoring work for each,
  every ten minutes, forever.

The bracket screen keeps the **unfiltered** score read, so a played-but-not-final game shows
its real score with no winner marked — and says "waiting on the correction window" rather
than rendering as a blank page for seven days.

### One league's failure never stops the others

Every cron loops over leagues, and a throw inside that loop must never escape it. Four
routes do this; three always did it correctly. `score-week`'s playoff block was the
exception and the **only** deny-by-default catch in the repo — an `instanceof PlayoffError`
allowlist that rethrew everything else.

`BracketError extends Error` directly, so an undersized field escaped, aborted the whole
run, and left every league after it in a query with **no `ORDER BY`** unscored — the same
set every ten minutes, deterministically.

**The fix is the shape, not the class.** Adding `BracketError` to the allowlist would have
left `StandingsError` — reachable from the same `seedOrder` call — and every future class
exactly as exposed, because none of these share a base class for an `instanceof` to catch.
So it records and continues, like `waivers`, `trades`, `draft-tick`, and `score-week`'s own
scoring catch. **If you find yourself adding an error class to an allowlist inside a
per-league loop, the allowlist is the bug.**

**Nothing is swallowed.** The failure is reported as `bracketProblem`, because a league
whose bracket can never be built would otherwise look healthy forever. `BracketError`
carries a `code`: `FIELD_TOO_SMALL` and `NOT_ENOUGH_WEEKS` are that league's own frozen
rules, `INVARIANT` is our bug in the ladder that decides who gets paid, and it defaults to
`INVARIANT` so a new throw site is ours until someone says otherwise.

**Byes are sized to the real field.** `byeSeeds` is a signed number, but nothing ties
`playoffTeams` to how many people actually joined — five friends in a twelve-seat league
play a five-team bracket. The signed count wins where it fits and is derived where it
cannot, which is a deliberate reversal of what `bracket.ts` used to claim. The quiet case
matters more than the crash: **four teams never threw**, it just played a bracket nobody
agreed to, with seed 1 idle twice and one game all postseason.

**Fixed since, in schema 5: a payout may only name prizes the field is certain to be able
to award.** A pot league with 6 or 7 members could never settle — `consolationField` is
`standings.slice(playoffTeams)`, so at the default `playoffTeams: 6` the consolation field
is 0 or 1, `bracketFor` returns null, and since CONSOLATION was a paid prize
`championship().complete` could never be true. Both built-in payouts (70/20/10 and
winner-take-all) now name only champion, runner-up and best record, all decidable at any
size. The consolation bracket and the third-place game are still _played_.

**The residual is a custom payout.** `validateLeagueRules` cannot catch it — nobody has
joined at creation, so the field size is unknown. The first moment it is known is
`drawDraftOrder`, which selects the teams and locks the field in one transaction, and it is
the last moment a refund is still clean. A guard there is the outstanding piece.

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
`IN_A_TRADE`), by `proposeTrade`, and by `acceptTrade` — the proposal's checks are stale by
the time anyone accepts.

**In `acceptTrade`, take every row lock first and read the freeze set second.** The obvious
order is wrong and looks right: two concurrent accepts of the same player both read an
empty freeze set _before_ either takes a lock, the loser then blocks, wakes after the winner
commits, re-checks a snapshot that predates it, and passes. Both trades reach ACCEPTED. The
lock would be doing real work and guarding a value already read. PGlite is single-connection,
so no test in this repo can catch that — it has to be got right by reading.

**Execution refuses rather than inserting when the release matches no row** (`ASSET_GONE`,
recorded as EXPIRED). This is the last line of defence and the only one that does not depend
on knowing _how_ the player left: accepted twice, dropped through a path that skipped the
freeze, or claimed off waivers. Upstream checks each close one route; this closes the
outcome. Without it a manager accepts a trade and cuts the player they promised, and
execution finds a hole where a roster spot used to be. `0005`'s `(team_id, player_id)` index
could not catch that at all — it was per-team, so the same player on two different teams
satisfied it; migration `0022` replaced it with `(league_id, player_id)`, which can, but only
as a constraint violation. `ASSET_GONE` is still the one that says _which_ asset is gone.

**Execution releases and re-adds roster rows rather than repointing them.**
`roster_entries` is append-only with `released_at` precisely so any past week's roster is
reconstructible; a trade that edited history would make a settled week unverifiable. It
does **not** go through `dropPlayer` — a traded player must never surface on waivers.

**The deadline is checked twice, against the week the trade would _execute_.** At proposal
against the earliest week it could land in, and again at resolution — a trade left
unaccepted for days slides past the first check. A window closing past the deadline
**expires** the trade, rosters untouched. That is what `EXPIRED` in the `trade_state` enum
is for; it was unused before.

**Both checks derive that week themselves, from `transactionWeek`, and share one
comparison.** They used to be two independent implementations of one rule — `proposeTrade`
took a `week` field computed by the route, and `resolveDueTrades` asked `currentWeek` — and
both were wrong the same way. `currentWeek` names the week of the most recent kickoff, so
from a week's last game until the next week's first it keeps answering a week whose games
are over: a trade resolving on the Tuesday or Wednesday after week 11 executed into week
12's rosters while being checked against week 11. `pastTradeDeadline` in `@rostr/core` is
now the only place the comparison happens.

**An execution week of `null` is past every deadline.** `transactionWeek` cannot name one
when the season's games are exhausted, and reading that as "not past the deadline" would
open the trade window permanently the moment a season ended — the January free-for-all the
deadline exists to prevent. The strict direction costs a league with no schedule ingested
its trade window, and such a league cannot set a lineup either, so it is not operational.

**`currentWeek()` in `week.ts` exists so no route takes a week from the client.** A
deadline checked against a client-supplied week is not a deadline — anyone could trade in
January by posting `week: 1`. Routes that legitimately display an arbitrary week (a past
lineup) still accept one; routes enforcing a rule must not — and a rule-enforcing caller
wants `transactionWeek` rather than this one. `score-week` still carries its own copy of
the same SQL (`apps/web/src/app/api/cron/score-week/route.ts:46-54`) rather than importing
it; that is tolerable, because it wants exactly the lagging semantics, but it is a copy and
not a shared call.

**A trade never leaves the league it was proposed in, and until recently only the _veto_
enforced that.** `proposeTrade` took the receiving team out of the request body and never
joined it to the league; `acceptTrade` loaded a trade by id alone and read its `league_id`
only to fetch rules. So a manager with a team in two leagues could propose in one naming
the other, accept from the far side, and let the hourly cron execute it — moving a player
between two closed pools.

Nothing caught it downstream, and that is the part worth remembering: `0022`'s trigger
derives `roster_entries.league_id` from the destination team, so the imported row lands
correctly stamped and `roster_entries_one_owner_per_league` is satisfied. The result is
indistinguishable from a legitimate acquisition. And because `resolveTrade` releases with a
direct `UPDATE` rather than through `dropPlayer`, neither player touches `waiver_wire` — so
the receiving league's blind claim queue and priority order are bypassed in both directions.

Both teams are now bound at proposal, and every other entry point **derives** the league by
joining rather than taking it as an argument — the shape `vetoTrade` has used since `0020`,
and the reason it was the one entry point never exploitable. A `leagueId` parameter would
close the same hole while creating an obligation each future caller has to honour.
Migration `0026` makes the row unrepresentable, using the composite uniqueness `0020`
already added and did not use.

**A veto is scoped to the trade's own league, at three layers.** `vetoTrade` refuses an
outside voter (`NOT_IN_LEAGUE`); the tally in `loadTrade` counts only rows from teams that
are in the league, not bots, and not party to the trade — the _same three conditions as the
electorate it is compared against_, because a numerator and denominator that disagree are
what force a veto nobody cast; and migration `0020` makes an out-of-league row
unrepresentable with a composite foreign key. Guarding only the door was not enough:
`trade_vetoes.team_id` is ON DELETE RESTRICT, so a row already written could not be cleaned
up by deleting the team.

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

### Joining and staking are one approval

`JoinPanel.onchainJoin` puts `join_league` and `deposit` in a **single transaction**.

They used to be two, in two different components, so a pot league asked a new member for
**four wallet approvals**: prove the wallet, sign the rules, take the seat, pay. Four is
where somebody says "I'll do it later" and doesn't, and each one of those is a league that
does not fill. Nothing was wrong with either transaction; the count was the problem.

**An atomic failure is the good outcome here.** If the member cannot cover the buy-in, the
join rolls back with it rather than leaving a seat claimed and unpaid. That only became
safe once #18 removed the on-chain seat cap — before it, an unfunded seat was a permanently
denied one, so grabbing a seat early had value. Now it has none. The two changes compose,
and the UI says so plainly, because an all-or-nothing transaction otherwise reads as a
failure rather than as the safe result.

**Three states, not two.** The retry reads the `Membership` account itself rather than
merely checking that it exists, which was sufficient while the halves were separate and is
not now: no account (send both), `deposited == 0` (send the stake alone — an interrupted
member, or one who joined before batching existed), funded (send nothing, recover the
signature, re-POST). Reading the second as the third would tell a member they had paid when
they had not.

`DepositPanel` keeps its stake button for exactly that middle state, and says so rather
than presenting itself as the normal path.

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

### The on-chain join, and what it unblocked

`apps/web/src/app/api/leagues/[id]/join-onchain/route.ts`, migration `0024`.

The app recorded a membership in Postgres and **never invoked `join_league`**, so the
on-chain `Membership` PDA was never created — which made `deposit` and `refund_stake`
unreachable no matter how well they were wired. Fixed 2026-08-11 (#63, on Ammar's #29).

**The wallet is derived from the caller's own `league_memberships` row**, never taken from
the request — `memberWallet`. That is the same helper the deposit and refund routes use,
and collapsing two independently-written copies of it into one was most of the work of
landing this. Its docstring carries the ordering guarantee: **no on-chain record without a
consent record behind it.**

**Two cluster questions, both asked.** `assertRpcCluster` confirms the endpoint really is
the chain this deployment declares; the route then confirms _that_ chain is where this
league was anchored. A correctly configured server reading the right chain can still be
looking at a league anchored elsewhere, and the PDA is byte-identical everywhere, so the
row would look right.

**The record upserts and is deliberately not write-once**, unlike the chain anchor in
`0014`. There is exactly one anchoring transaction per league; here a re-post after a lost
response is the ordinary case and has to succeed. What makes that safe is authorisation
rather than immutability — the caller can only ever write the wallet their own consent row
names. Do not add an immutability trigger without first giving the retry somewhere to go.

### Deposit and refund: `deposited > 0` is not "currently staked"

`packages/escrow/src/verify.ts`, the two money routes, migration `0023`.

**`refund_stake` sets `refunded = true` and leaves `deposited` alone.** Its own comment
calls it "the historical record". So the reachable `Membership` states are:

| `deposited` | `refunded` | means                                      |
| ----------- | ---------- | ------------------------------------------ |
| 0           | false      | joined, has not staked                     |
| > 0         | false      | staked, money is in the vault              |
| > 0         | **true**   | staked and withdrawn after the timelock    |
| 0           | true       | unreachable — refund requires `amount > 0` |

Reading `deposited > 0` as "currently staked" is the trap, and **both** verifiers fell
into it in opposite directions:

- `verifyOnChainRefund` was **inverted**. A genuine refund lands in row three, which it
  rejected as `ALREADY_REFUNDED` — so **no real refund could ever be recorded** — while it
  answered `ok` for row two, a member whose money was still in the vault.
- `verifyOnChainDeposit` never consulted `refunded` at all, so row three read as a live
  deposit; and its failure code for row one was `ALREADY_DEPOSITED`, which told a member
  who had not paid that they had.

**Composed with `walletAddress` taken from the request body**, the refund inversion let any
signed-in account mark any staked member as refunded. The on-chain guarantee was never in
question — no Rust was involved and `refund_stake` still needs the member's own signature.
This was the _accounting_ disagreeing with the chain, which in a league where the record is
what people read is its own kind of serious.

**The wallet is derived, never accepted** — `memberWallet` reads this user's own
`league_memberships` row, the one carrying their signature over the rules hash. Deriving
beats validating a supplied address: a caller with no way to _name_ a wallet has no way to
name somebody else's.

**That path was inert until on-chain join shipped, and it is not any more.** The
guarantee used to be structural: `deposit` requires a `Membership` account, only
`join_league` creates one, and the app did not invoke `join_league` — so
`verifyOnChainDeposit` answered `NOT_JOINED` for everyone and nobody had to remember
anything. `JoinPanel` now sends `join_league`, and the property went with it. The
paragraph that used to sit here outlived what it described, which is the exact defect
class this file warns about two sections up.

**What replaces it is `potDepositGate`** (`packages/escrow/src/settlement.ts`), read
through `depositsOpen()` in `apps/web/src/lib/pot.ts`:

```
open  =  settlementShipped(ESCROW_IDL)  ||  cluster !== "mainnet-beta"
```

The committed IDL is what answers "can this program pay a pot out". It is in the tree,
`pnpm idl:check` fails in the Anchor job when it drifts from the Rust, and a tripwire test
pins the five instruction names — so the commit that ships D6 opens the gate **in the same
commit**, and is forced to visit the file that decides it. No date, no environment
variable, nothing to unset.

Two things it is not. It is a **client-side** rule: `deposit` is permissionless on-chain,
so a member who has joined can build the instruction themselves and nothing in TypeScript
stops them. It is weaker than what it replaces, and the comment there says so rather than
reprising the sentence it retired. And it is **not** applied in the deposit route — see
that file for why refusing to record a deposit the chain has already accepted produces
amnesia rather than an emptier vault.

**Off mainnet the gate is open**, deliberately: the funding path has to be exercisable end
to end, which is what Aug 22's "fundable" asks for and what `stake.test.ts` already proves
against a real validator. What closes is a **mainnet** buy-in during the window where the
only exit is the timelock — and the create form's default `refundUnlockAt` is
**2027-03-01**, so that window is about seven months long.

**The original program test only exercised `NOT_JOINED`** — the one refund path that was
already correct — which is how an inverted verifier shipped green. `membership.test.ts`
now pins all four states as units that run with no toolchain, and `stake.test.ts` proves a
real refund on a real validator produces the state those units describe, so the two cannot
agree with each other while both being wrong about the program.

### One declaration of which chain, and everything checked against it

`packages/escrow/src/cluster.ts`, `apps/web/src/lib/cluster.ts`.

**The PDA is byte-identical on every cluster.** A league anchored on devnet and the same
league anchored on mainnet derive the same address from the same UUID, so "the account
exists" answers nothing — the only thing separating them is which endpoint you happened
to ask. `leagues.chain_cluster` records the answer and migration `0014` makes it
**write-once by trigger**, so a wrong value is permanent and `joinLeague` gates on it.

There were **three independent sources** of that answer and no comparison between any
two:

| Where               | Variable                     | If unset            |
| ------------------- | ---------------------------- | ------------------- |
| Browser — _signs_   | `NEXT_PUBLIC_SOLANA_RPC_URL` | **mainnet-beta**    |
| Server — _verifies_ | `SOLANA_RPC_URL`             | throws              |
| Join gate           | `SOLANA_CLUSTER`             | **no check at all** |

The dangerous default was on the one that signs. A commissioner with it unset sent
`initialize_league` to **mainnet** while the server read devnet, found nothing, and
returned `NOT_FOUND` — which the route documents as "retry". Retrying cannot work; the
account is real, it cost mainnet rent, and with no `close` instruction that league can
never be anchored there again, only recreated under a new id. Worse downstream: `deposit`
is permissionless once a league exists, so a member could put real USDC into a vault this
deployment never looks at.

**`SOLANA_CLUSTER` is now the declaration**, required in production and `devnet` in
development — the same shape as `cronForbidden`, and for the same reason. Devnet is the
fallback that fails _visibly_: nothing verifies, nobody loses anything, and the missing
config surfaces in minutes. Defaulting to devnet in _production_ would be its own quiet
disaster, hence the refusal there.

**The RPC is verified by genesis hash, not by reading its URL.** `resolveCluster` asks the
node which chain it is. Every real deployment points at a private RPC — the public nodes
are rate-limited and the order draw alone makes ~30 sequential calls — and a private
endpoint's hostname says nothing about what is behind it. The constants in
`GENESIS_HASHES` were **verified against the live public endpoints on 2026-08-11**, not
recalled; they are genesis blocks, so a change would mean the chain was reset.

**An unrecognised genesis hash resolves to `localnet`, never to a public cluster.** That
is the fail-safe direction and it only works because callers _compare_ the result against
the declaration rather than trusting it: declare mainnet, get a fork or a local validator,
get `localnet`, mismatch, refuse.

**`clusterOf` no longer falls back to `mainnet-beta`** — it throws. That fallback was the
bug in its purest form: an ordinary devnet endpoint like `https://rostr.rpcpool.com/<key>`
matched none of its substring branches and was recorded as mainnet, permanently, in the
column the join gate reads. It survives as an endpoint-_shape_ helper for the program
tests. Anything writing `chain_cluster` uses `resolveCluster`.

**The cluster is asserted before the anchor route reads a single account**, not just
before it writes. Every check in that route is taken against whatever `connection` is
talking to, so a wrong cluster makes `verifyLeagueAnchor` answer `NOT_FOUND` for a league
that is correctly anchored — and the route calls `NOT_FOUND` a retry. Its return value is
what gets recorded, so there is no second path by which an unverified cluster reaches the
write-once column.

**The join route's cluster check is no longer a conditional spread.** An unset
`SOLANA_CLUSTER` did not relax it, it deleted it, and the deployment guaranteed to have it
unset is the one nobody configured.

**The browser cross-checks itself at runtime.** `ClusterBanner` asks its endpoint for a
genesis hash and warns when it disagrees with the build's `NEXT_PUBLIC_SOLANA_CLUSTER` —
the only place the browser's chain is a fact rather than a convention, and the browser is
where the signing happens. A banner rather than a block, because the adapter belongs to
the extension and the server already refuses; a failed lookup says nothing, because
claiming a mismatch on a network blip trains people to dismiss the real one. The
comparison lives in `clusterMismatch` in `@rostr/escrow` rather than in the component,
since `apps/web` cannot test React and a mapping inside a component is verified only by
being run in production.

### A private league is now actually private

`apps/web/src/lib/visibility.ts` and `league-read.ts`.

`league.visibility` sits in the **frozen, hashed, member-signed** rule set and until
2026-08-11 was **read back nowhere** — written to the `leagues` row at creation and never
consulted again; every other occurrence in the repo was a test. That is the same defect
`botsAllowed` was removed for: a guarantee members signed that did nothing. A rule set
saying PRIVATE while the standings, the draft board and every team's bench were readable
by anyone holding a URL was making a promise the code did not keep — and the URL is not a
secret, it is in browser history, in screenshots, and in whatever chat the invite was
pasted into.

**Read from the frozen rules, not `leagues.visibility`.** The column is a denormalised
copy written at creation. Members signed the document, so the document decides, and a
future bug in that write cannot quietly open a private league. There is a test that
rewrites the column and asserts the answer does not move.

**404, never 403.** A 403 confirms the league exists, which is the one fact an unguessable
id protects. Pages call `notFound()` for the same reason — a "this league is private"
screen is a disclosure.

**Both layers are gated, and only doing one would have been cosmetic.** The `standings`,
`matchup` and `bracket` **pages query the database directly** while their components fetch
the API, so gating routes alone leaves the server-rendered half wide open, and gating pages
alone leaves the API open to anyone with `curl`.

**Two files stay open on purpose** and are named in `league-read.test.ts` with reasons:
`/leagues/[id]` and `api/leagues/[id]/join`. `RULES.md` requires the full rule set to be
shown before anyone joins, and an invitee is by definition not yet a member — gating the
entrance would make "shown before you join" unsatisfiable for exactly the private leagues
invite links exist for. What is gated is everything reporting how the league is _going_.

**PUBLIC leagues are not gated at all.** `/api/leagues` already publishes their ids, and
being findable is what public means.

`league-read.test.ts` sweeps every file under `api/leagues/[id]/` and `leagues/[id]/` and
fails a new one that gates nothing. It went unenforced for months not because anyone
decided reads were open but because nothing was obliged to ask. **Its `GATES` match the
refusal, not the identifier** — three routes mention `context.myTeamId` only to label the
response, and matching the bare name certified them as gated when they were not, which is
the exact shape of bug the file is named after.

### The scoreboard

`packages/db/src/matchup.ts`, `/api/leagues/[id]/matchup`, `Scoreboard.tsx` on
`/leagues/[id]/matchup`. C12's missing half — the standings shipped long before the screen
a manager actually looks at on a Sunday.

**It scores through `scoreTeamLineup`, the same function the cron uses.** Not a second
implementation. A scoreboard that disagreed with the standings would be worse than no
scoreboard, and there is a test asserting the two match for every matchup in a week.

**A finalised week reports the stored total, never a fresh recompute.** Points are
recomputed from `stat_lines_current` on every read, which is how a live score stays live —
but once `finalized_at` is set that number decided a win, a seed, and in weeks 14 and 17 a
payout. A correction landing afterwards changes `stat_lines_current` and must not change
the result.

When the two disagree, `restatedMilliPoints` reports what the recompute says and the screen
shows both. **Do not "fix" this by displaying one number.** A correction that arrived too
late to count is a real event; hiding it is the silent restatement this project exists to
prevent, and showing only the live number would rewrite a settled week.

**`yetToPlay` and `inProgress` are given as much weight as the score, deliberately.** Being
up twenty with three players left is a different position from being up twenty with none,
and no total conveys that. Both come from `games.kickoff_at` and the game status — the same
source every lineup lock derives from.

**Game state is never inferred from whether a player has points.** A player can be well into
his game with nothing to show for it, and reading zero as "has not played" tells a manager
they are still live when they have already lost. Kickoff passed and not final means
in-progress, whatever the stat line says. Tested.

A player with no game that week is `BYE`, not `YET_TO_PLAY` — there are no points still
coming.

`loadWeekMatchups` takes `now` rather than calling `Date.now()`, so game state is
deterministic and the finalisation cases are testable.

**The week may be supplied by the client here**, unlike the trades route. Nothing on this
path enforces a rule — it only reads, and browsing back through the season is the point of
the week selector.

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

**Which makes `refundUnlockAt` the only thing protecting the pot, so it has a floor.**
Because the refund is unconditional once it opens, a date set before the season ends is not
a smaller version of the same design — it is a different one. Refunding decrements
`total_deposited` but touches neither `member_count` nor the `Membership`, so a losing
manager who withdrew in week 6 would keep their roster, their standings place and their
claim on the pot, and play out the season with nothing at risk. Until 2026-08-11 the only
checks were `> 0` off-chain and `> now` on-chain: a commissioner could have set it to next
Tuesday.

`validateLeagueRules` now refuses a league whose refund opens before
`earliestRefundUnlock(...)` — the draft, plus the last scheduled week, plus the paying
correction window, plus **sixty days**. Every term is already in the frozen rules, so this
adds no field and **does not move the golden hash**.

**The check is at creation, never at refund**, and that distinction is the whole design.
A creation-time rule can only refuse to _make_ a league; a rule on `refund_stake` could
trap money in one that already exists.

**Sixty days, not thirty.** The floor is measured from the draft because that is the only
real timestamp the rules carry, and the rules do not record the gap between the draft and
kickoff — eighteen days in 2026 — so the estimate lands early. Worked through: a 10-day
buffer puts the floor at Jan 5, _before_ the Jan 10 settlement, which is actively broken;
30 days gives a fortnight of real margin; 60 gives about six weeks. The sizing follows from
the failure modes being asymmetric — too late is members waiting longer for money they will
certainly get back, too early is the pot being taken by whoever transacts first, in a
program with no authority field and nothing to claw it back with. An uncertain estimate
rounds toward the side where being wrong is merely annoying.

**It also separates payout from refund without either instruction knowing about the
other.** D6 will draw on the same vault, and the grace window is the gap between "winners
can be paid" and "the escape hatch opens" — so the two cannot both be legal at once. If
settlement misses that window, refunds open and everyone recovers their stake, which is the
correct failure and not a bug.

`CreateLeagueForm` seeds its refund field from the **same function**, so the form cannot
suggest a date the server will refuse. It used to hardcode `2027-03-01` under a comment
reading "two weeks after the championship" — wrong by six weeks, and a constant sitting
next to a draft date the commissioner can move.

**Still open, and a separate decision:** `RULES.md` promises auto-dissolve for a league
that never fills, and dissolve by unanimous consent. **Neither exists** — the program has
exactly five instructions and none of them is one. The timelock is silently doing that job,
which for a league that never drafted means waiting months for money that was never at
stake.

**`deposit` takes no amount argument.** It moves `league.buy_in` and nothing else, so
"everyone stakes the identical amount" is structural rather than a check that could be
reordered around. A member who wants to overpay has no instruction that permits it.

**Legacy SPL Token, not `token_interface`** — deliberate, and worth not "modernising". A
Token-2022 mint with the transfer-fee extension delivers less to the vault than the member
sent, silently breaking equal stakes; a transfer hook is arbitrary code inside a deposit.
USDC is a legacy mint. Milestone E's roster NFTs are Token-2022 and unrelated to this.

**The vault's authority is the league PDA**, so no key held by any person can move the
pot — only this program, only through these instructions.

**`max_teams` is published, not enforced, and D6 must be built knowing that.** The
`member_count < max_teams` gate was removed from `join_league` on 2026-08-11 (issue #18):
it guarded a guest list the program cannot read. Being _in a league_ is a Postgres fact — a
team, a roster, a draft slot — while a `Membership` here means only "this wallet has a
stake". So the check handed seats out first-come to anyone on the internet while the real
roster was decided elsewhere, and since nothing closes a `Membership` or decrements
`member_count` — not even `refund_stake` — claiming all twelve for about **0.011 SOL**
bricked a league permanently. `joinLeague` enforces the size against the actual roster, and
always did.

**The consequence for settlement: pay the known member set, never a percentage of the vault
balance.** Anyone may now open a `Membership` and deposit into any league they can name.
That is self-harm rather than leverage — they cannot win and their stake is locked until
`refundUnlockAt` — but it means `total_deposited` is not the pot. Paying `bps × vault`
would hand a stranger's money to the winners and leave the vault short when that stranger
refunds. Settlement takes the members it is paying as input and computes from
`real_members × buy_in`. This is the better shape regardless: a payout derived from a
mutable balance is one deposit away from being wrong.

**An eviction instruction was considered and rejected** as weaker, not simpler: it can only
clear seats that were never funded, so an attacker who deposits still blocks the league and
merely pays for the privilege with money the timelock returns.

`payout_bps` is positional, indexed by the `prize` module. **That order is
`PRIZE_ORDER` in `packages/escrow/src/instructions.ts`, not the declaration order of the `PrizeKey`
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

### The one test that spans both halves

`programs/rostr-escrow/tests/anchor.test.ts`. Everything else tests one side against a
stand-in for the other: the database tests anchor a league by calling `recordChainAnchor`
with a made-up signature, and the program tests hash rules no league ever had. **Both pass
whether or not the two agree.**

They have to agree on exactly 32 bytes. Postgres stores them as hex, the program stores
them as raw bytes, and the only symptom of a wrong conversion is that `verifyLeagueAnchor`
reports a mismatch on a league that is correctly anchored — nobody can join, and nothing
else in the repo fails. So this drives the real `createLeague`, sends the real instruction
to a real validator, verifies it the way the route does, and joins.

It also builds a provider with `{} as Wallet`, which is what `readOnlyEscrow()` does on the
server. Anchor never touches the wallet on a read path — but that is an assumption about a
library, and every other test here holds a funded wallet, so it would have been wrong in
production and green everywhere else.

`vitest.program.config.ts` aliases `@rostr/db`, `@rostr/db/testing` and `@rostr/core` to
source for this. Aliasing to source is also what makes each package's own dependencies
resolve, since the program suite runs from a directory that declares none of them —
`testWallet()` lives in `packages/db/src/testing.ts` for exactly that reason, because the
curve library and base58 are dependencies of that package and a test outside it cannot
import them.

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
matches the program's `prize` module, and is **not** the
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
matches the stack in `percolator-launch`). **Provisioned since 2026-08-06** — the
connection string is in `.env`, which is gitignored and has never been committed. This
file and `SETUP-REQUIRED.md` both said "not set up yet" until 2026-08-14, and that
staleness cost real time: a migration renumber was reasoned about on the premise that
nothing had ever been applied.

**It is not automatically in sync with `main`.** Nothing in CI runs migrations against it
— there is no Postgres service in `ci.yml`, and every test builds a fresh PGlite database
— so it only moves when somebody runs `pnpm db:migrate` by hand. On 2026-08-14 it was at
version 20 while `main` carried through 0027. Check with `pnpm db:status` before assuming.

Migrations are **forward-only** plain SQL. There are no down migrations: a league's rules
are immutable and its history must stay auditable, so the answer to a bad migration is
another migration. Editing an already-applied file makes the runner refuse to start.

**Numbering is the part that only bites across machines**, and it is not the runner's job
— read [`packages/db/migrations/README.md`](packages/db/migrations/README.md) before adding
one. Two branches can pick the same number, and on this project they have: #72 and #95
both took `0025` against a `main` at `0024`, both went green, and merging both would have
thrown `Duplicate migration version 25` on load and failed every database-backed test.
Take the next number **above main's highest**, renumber on rebase if main moved, and never
merge a PR whose number is at or below main's head. CI now refuses the second half of that
(`scripts/check-migration-numbers.mjs`); the first half is caught only by requiring
branches be up to date before merging, which `main`'s protection does.

---

## Invariants — do not break these

**1. The rules hash is load-bearing.** `packages/core/src/canonical.ts` defines the only
legal encoding of a rule set. Its SHA-256 goes on-chain and members sign it when they
join. If encoding drifts, every league created before the drift stops verifying.

There is a **golden fixture test** pinning the hash, at the bottom of
`packages/core/src/rules/rules.test.ts`. If it fails, do **not** update the constant to
make it pass — find what changed the encoding. CI checks it on Node 22 and 24 for exactly
that reason.

**The constant is deliberately not repeated here.** It was, and it went stale: this file
named a hash from schemaVersion 1 while the test had moved through 2, 3, 4 and 5. A
pinned value copied into two places is a value that will disagree with itself, and the
disagreement is worse than useless — it makes a correct encoding look drifted. The test
carries the constant and a dated changelog of every legitimate move, each recording why
the schema changed and that no leagues existed at the time. That log is the thing to read
before touching it.

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

| Decision                                         | Status                                                                   |
| ------------------------------------------------ | ------------------------------------------------------------------------ |
| Full PPR scoring                                 | **Settled** — table in `docs/RULES.md` §1                                |
| Schedule luck retained                           | **Settled** — median scoring was proposed and **rejected**               |
| Rolling waiver priority                          | **Settled** — FAAB proposed and **rejected** for v1                      |
| NFTs _are_ the roster, not souvenirs             | **Settled** — Token-2022, transfer hook + permanent delegate             |
| NFTs persist as trophies, labelled "Player YYYY" | **Settled**                                                              |
| Trades vetoable, never automatic                 | **Settled** — 48h escrow, ⅓ of uninvolved managers                       |
| Trade deadline set by the commissioner           | **Settled** 2026-08-08 — default 11; binds on the execution week         |
| Rules immutable, shown before joining            | **Settled**                                                              |
| Per-game score updates, not real-time            | **Settled** — cost is not the reason; simplicity is                      |
| Mainnet with the pot live for 2026               | **Settled** — risks were raised and the owner chose this                 |
| Payout 70/20/10, or winner-take-all              | **Settled** 2026-08-10 — the commissioner picks; champion always largest |
| Abandonment (3 strikes → stake forfeit)          | **Removed** 2026-08-08 — could not fire; autofill does the job           |
| Consolation bracket played but unpaid            | **Changed** 2026-08-10 — a paid consolation cannot settle a small league |
| IP-based sybil blocking                          | **Rejected** — breaks households, defeated by any VPN                    |
| Protocol fee: 1%, once, at settlement            | **Settled** 2026-08-07 — in the hashed rules; never on a refund          |
| Buy-in between $5 and $50 per member             | **Settled** 2026-08-07 — a range; both bounds enforced on-chain          |
| Pot mints must have six decimals (season one)    | **Settled** 2026-08-07 — what makes the $50 cap mean dollars             |
| Free leagues anchor their rules hash on-chain    | **Settled** 2026-08-07 — `initialize_free_league`                        |
| Autofill on by default, per-team toggle          | **Settled** 2026-08-08 — method frozen in rules, switch is yours         |
| Autofill ranks on weekly projections             | **Settled** 2026-08-08 — a decision, not a fact; see DECISIONS           |

---

## Environment

**Arriving at either machine: `git pull` then `CI=true corepack pnpm install`.** The
workspace gains packages (most recently `@rostr/escrow`) and installs platform-specific
binaries for both Windows and Linux, so a stale `node_modules` fails in ways that look
like code errors rather than a missing install.

**This repo was started on a secondary Windows PC.** Tooling installed there: Node
v24.19.0, pnpm 11.20.0, gh 2.97.0, git. No Rust, no Solana CLI, no Anchor — so **nothing
under `programs/` can be built or tested there _locally_**. It can still be changed there
and verified on CI: `.github/workflows/anchor.yml` runs the full `anchor test` on every PR
touching `programs/**`. Push and read the job. That is slower than a local run and much
faster than waiting for the other machine. `pnpm test`, `typecheck`, `lint` and the
whole TypeScript side work fine, including `@rostr/escrow`, because the IDL is committed.
`anchor test` and `pnpm idl:sync` are main-PC only.

**The main PC now has the Anchor toolchain**, so Milestones D and E are no longer blocked
by machine. Installed under WSL2/Ubuntu 26.04: Rust 1.97 (stable) alongside a pinned
1.90 default, Solana CLI 4.0.0, Anchor 0.31.1 via AVM, Node 22 via nvm. Verified by
building and testing an unrelated Anchor program against a local validator.

Six things that have each cost an hour and will cost it again:

- **A long-running local validator drifts behind the wall clock, and timelock tests
  start failing for no reason.** After ~4 hours one had produced 10,176 slots where
  400 ms/slot predicts ~36,000, so its on-chain clock was **64 minutes behind** `date`.
  Tests set `refundUnlockAt` from wall time, so `refund_stake` answers `RefundLocked`
  on a stake whose timelock has visibly passed, and "rejects a refund unlock in the
  past" stops rejecting because a past wall time is still in the validator's future.
  Seven tests failed this way and all 66 passed on a fresh ledger. **Check the drift
  before debugging the program**, and restart if it is more than a minute or two:

  ```bash
  echo $(( $(date +%s) - $(solana -u http://127.0.0.1:8899 block-time --output json \
    $(solana -u http://127.0.0.1:8899 slot) | grep -o '[0-9]\{10\}' | tail -1) ))
  ```

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
pnpm test        # 1222 tests, all green
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

- **The escrow review** — and note this is **not** a commercial audit. That was decided on
  2026-08-05: no firm for the 2026 season, because the 2–4 week booking lead time sat on
  the critical path. The owner reviews the program himself and has a professional auditor
  who will look once the tech is mostly built; a commercial audit is deferred past the
  season, not dropped. `SETUP-REQUIRED.md` carries the decision and, more importantly, the
  four things that limit exposure without a firm's sign-off — the $50 buy-in cap and the
  unconditional timelock refund being the two that do the work. This entry described a
  booking that had already been decided against.
- **Bot draft sophistication** — a scope decision needed before Milestone B.
