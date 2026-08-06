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

**Done — 232 tests, CI green:**

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

**Next, in order:**

1. **B6–B8** — the stats provider adapter (Tank01), player and season sync. Needs a
   Tank01 key, free tier. This is what supplies `DraftablePlayer.rank` — the draft
   currently takes ranking as an input and has no source for it.
2. **B16** — persist the draft: it is a pure state machine with no storage behind it yet.
3. **D1–D10** — the escrow program. **Write this early.** The audit is 2–4 weeks of
   calendar time and it gates pot leagues opening on Aug 22. Blocked on the secondary PC
   (no Rust/Anchor).
4. **Finish A9's UI** — there is no session yet, so `JoinPanel` posts an empty `userId`
   and the league creation form is a preview only. Both marked TODO in the code. Needs
   the Supabase project, which the owner is setting up on their main PC.

### The draft

`packages/core/src/draft/`. Pure state machine — transitions return new state, nothing
runs a clock or touches a database. That is why slow drafts need no real-time
infrastructure and why a full 12-team draft plays out instantly in a test.

- **Order is seeded, never `Math.random`.** Anyone holding the seed can recompute it and
  confirm nobody reshuffled. Use the league's rules hash: already on-chain, already
  unforgeable.
- **Roster legality is bipartite matching** (`roster.ts`), not per-position counting.
  Counting is _wrong_ because of FLEX — see the comment at the top of that file before
  changing it. This underpins the rule that stops six quarterbacks and no kicker.
- **One auto-pick routine serves clock expiry and every bot.** Do not fork them. Two
  implementations would diverge, and the divergence would read as "the bot outdrafted me
  while I was asleep".

Bot sophistication is still the open question: the current bots draft by need from a
supplied ranking. Positional scarcity, bye weeks, and tier breaks are not modelled.

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

**On the main PC you will need**, beyond Node and pnpm:

```bash
# Rust + Solana + Anchor. On Windows, use WSL — Anchor is painful natively.
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
cargo install --git https://github.com/coral-xyz/anchor avm --locked
avm install latest && avm use latest
```

Anchor work (Milestones D and E) is blocked until that exists.

### Getting started

```bash
pnpm install
pnpm test        # 49 tests, all green
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
