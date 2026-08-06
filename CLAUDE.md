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

**Done — 557 tests, CI green:**

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

- C1, and the standings half of C8 plus all of C9: schedule generation, records,
  tiebreaker chain, playoff seeding (`packages/core/src/season/`). **Matchup resolution
  itself still needs C6** — the scoring engine exists but nothing yet feeds team-week
  totals into `MatchupResult`.

- B6–B8: Tank01 adapter, box scores, live sync (`packages/stats/`, `packages/db/sync.ts`)

- B16: the draft persisted (`packages/db/src/draft.ts`, migration `0009`)

- The draft order drawn once from a Solana block, field locked at the draw (migration
  `0010`)

- Sessions, emailed sign-in links, and wallet linking by signature (migration `0011`,
  `packages/db/src/sessions.ts`, `apps/web/src/lib/session.ts`)

- The draft room (`apps/web/src/components/DraftRoom.tsx`, `api/leagues/[id]/draft/`)

**Next, in order:**

1. **League creation form** — still a preview; it does not post, so there is no way to
   make a league through the UI. Marked TODO in the code. This is what stands between the
   current build and an end-to-end run: create, join, draft.
2. **A scheduled job for expired picks.** Clocks only advance when someone reads the
   draft. See "The draft room" below.
3. **C2, C3, C6** — lineups, per-player kickoff locks, and team-week scoring. Needed by
   Sep 9, not Aug 22. C6 is what finally connects the scoring engine to `MatchupResult`.
4. **D1–D10** — the escrow program. **Write this early.** The audit is 2–4 weeks of
   calendar time and it gates pot leagues opening on Aug 22. Blocked on the secondary PC
   (no Rust/Anchor).

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

**Still true and still a gap: a draft nobody looks at does not advance.** Harmless for a
24-hour slow draft, and a live room is being polled — but it wants a scheduled job over
`draftsWithExpiredPicks()` before the season. "You had to keep the tab open" is not a rule
anyone agreed to.

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
`5afc934db3b3e1b1f5ec7a9e503f61e531aa925a6f966c41ec227118201da36a`. If it fails, do
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

| Decision                                            | Status                                                           |
| --------------------------------------------------- | ---------------------------------------------------------------- |
| Full PPR scoring                                    | **Settled** — table in `docs/RULES.md` §1                        |
| Schedule luck retained                              | **Settled** — median scoring was proposed and **rejected**       |
| Rolling waiver priority                             | **Settled** — FAAB proposed and **rejected** for v1              |
| NFTs _are_ the roster, not souvenirs                | **Settled** — Token-2022, transfer hook + permanent delegate     |
| NFTs persist as trophies, labelled "Player YYYY"    | **Settled**                                                      |
| Trades vetoable, never automatic                    | **Settled** — 48h escrow, ⅓ of uninvolved teams                  |
| Rules immutable, shown before joining               | **Settled**                                                      |
| Per-game score updates, not real-time               | **Settled** — cost is not the reason; simplicity is              |
| Mainnet with the pot live for 2026                  | **Settled** — risks were raised and the owner chose this         |
| Payout 60/15/10/10/5                                | **Settled** — champion must always be largest                    |
| Abandonment: 3 strikes → autolineup + stake forfeit | **Settled**                                                      |
| Consolation bracket pays out                        | **Settled** — it is the anti-abandonment mechanism, not a nicety |
| IP-based sybil blocking                             | **Rejected** — breaks households, defeated by any VPN            |

---

## Environment

**This repo was started on a secondary Windows PC.** Tooling installed there: Node
v24.19.0, pnpm 11.20.0, gh 2.97.0, git. No Rust, no Solana CLI, no Anchor.

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
pnpm test        # 557 tests, all green
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
