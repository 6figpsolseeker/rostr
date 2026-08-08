# Build Plan

Ordered by deadline and risk, not by what's easy or interesting.

---

## Principles

**1. The NFL calendar is the release schedule.** Settlement code doesn't run until
January. Playoff brackets don't run until December. Waivers don't run until Week 2.
Only _drafting_ and _scoring_ are genuinely due in the next five weeks. This turns an
impossible 35-day scope into a feasible one — as long as the ordering respects it.

**2. Long-lead items go first, regardless of when they're used.** The escrow program
isn't needed until January, but it holds real money in August and an audit takes 2–4
weeks of calendar time no amount of effort compresses. It gets written in week one.

**3. Ship vertical slices, not horizontal layers.** Every milestone below is a thing a
user can do end-to-end, UI included. A perfect backend with no interface proves nothing
and hides integration risk until the worst possible moment.

**4. Pure logic before infrastructure.** The scoring engine is a pure function with no
dependencies, and it decides who gets paid. It's written and tested before any database,
API, or chain code exists.

**5. Immutable things get right the first time.** Anything hashed into a league — the
rule set, the scoring table, the canonical JSON encoding — cannot be fixed later for
leagues already created. These land before a single league exists.

**6. Design programs early, deploy them late.** On-chain code is the most expensive thing
to change after the fact.

---

## The deadline ladder

| Date       | Week | What must exist                                         |
| ---------- | ---- | ------------------------------------------------------- |
| **Aug 22** | —    | **Leagues can be created, joined, funded, and drafted** |
| **Sep 9**  | 1    | **Lineups lock, live scoring, matchups resolve**        |
| Sep 16     | 2    | Waivers                                                 |
| Sep 20     | 2–3  | Trades + veto                                           |
| Nov 22     | 11   | Trade deadline enforcement                              |
| Dec 13     | 14   | Regular-season prize settles — **first real payout**    |
| Dec 16     | 15   | Playoff + consolation brackets                          |
| Jan 3      | 17   | Championship                                            |
| Jan 10     | —    | Final payouts (7-day correction window)                 |

Two hard deadlines: **Aug 22** and **Sep 9**. Everything else has months of runway.

---

## Critical path

```
core types ─→ scoring engine ─→ stats adapter ─→ season loop ─→ SEP 9
     └──────→ rules hash ─→ league create ─→ draft ─────────→ AUG 22
     └──────→ escrow program ─→ AUDIT (2-4wk calendar) ─────→ AUG 22
```

The audit is the long pole. It starts in week one or pot leagues cannot open on time.

### The escrow deployment problem

The escrow must accept deposits in August but doesn't pay out until January. Shipping an
unaudited contract that holds real money is not acceptable; neither is waiting for a
January-complete contract before August deposits.

The resolution, in order of importance:

1. **An unconditional timelock refund from day one.** After a hard date, any member can
   withdraw their own stake unilaterally, no matter what else is broken or unbuilt. Funds
   can never be permanently stuck, even if settlement is never shipped.
2. **Upgrade authority on a multisig**, disclosed prominently in the README. Not ideal,
   and dishonest to hide.
3. **Buy-in cap** for the first season, so early leagues can't lose life-changing sums to
   new code.
4. **Burn the upgrade authority** once settlement is audited, before Week 14 pays out.

---

## Milestone A — A league exists · target Aug 12

Foundations plus the first vertical slice.

| #   | Commit                                                          | Done when                                            |
| --- | --------------------------------------------------------------- | ---------------------------------------------------- |
| A1  | `chore: pnpm monorepo, TS strict, vitest, eslint, CI`           | `pnpm test` runs green in CI                         |
| A2  | `feat(core): sport registry — stat keys, positions, slot types` | NFL registered entirely as data                      |
| A3  | `feat(core): league rule schema + canonical JSON encoding`      | Byte-identical output for identical rules            |
| A4  | `feat(core): rules hashing`                                     | Same rules → same hash, across machines and versions |
| A5  | `test(core): rule hash golden fixtures`                         | Encoding can never silently drift                    |
| A6  | `feat(db): schema migrations from DATA-MODEL`                   | Migrations up/down clean                             |
| A7  | `feat(api): league creation, rules frozen at write`             | `league_rules` rejects UPDATE at the DB level        |
| A8  | `feat(api): rule set pinned to IPFS, hash stored`               | `rules_uri` resolves to the exact hashed document    |
| A9  | `feat(auth): email verification + wallet linking`               | One user, verified email, ≥1 wallet                  |
| A10 | `feat(web): app shell, wallet adapter, league create flow`      | A league can be created in a browser                 |
| A11 | `feat(web): rules displayed in full before join`                | Nobody joins without seeing the frozen rules         |
| A12 | `feat(api): join league, signature over rules hash`             | Consent stored as a signature, not a boolean         |

**A3–A5 are the highest-stakes commits in the project.** If canonical encoding is
unstable, hashes drift, and every immutability guarantee is decorative. Two library
versions that serialise a float differently are enough to break it.

---

## Milestone B — A league can draft · target Aug 22 · **HARD**

If this slips, there is no 2026 season.

| #   | Commit                                                        | Done when                                           |
| --- | ------------------------------------------------------------- | --------------------------------------------------- |
| B1  | `feat(scoring): LINEAR rule evaluation`                       | Multiplier rules score correctly                    |
| B2  | `feat(scoring): integer milli-point arithmetic`               | Zero float drift — see note                         |
| B3  | `feat(scoring): TIERED rule evaluation`                       | DST points-allowed ladder correct at every boundary |
| B4  | `feat(scoring): NFL full-PPR default rule set`                | Matches `RULES.md` §1 exactly                       |
| B5  | `test(scoring): golden fixtures from real 2025 box scores`    | Hand-verified against ESPN totals                   |
| B6  | `feat(data): provider adapter interface`                      | Engine has no knowledge of any provider             |
| B7  | `feat(data): Tank01 adapter`                                  | Players, positions, byes, box scores                |
| B8  | `feat(data): player + season sync job`                        | Full 2026 player pool in Postgres                   |
| B9  | `feat(draft): snake order generation`                         | Order reverses per round, deterministic from seed   |
| B10 | `feat(draft): state machine + pick validation`                | Illegal picks impossible, not merely rejected       |
| B11 | `feat(draft): personal queue`                                 | Persistent, reorderable, survives disconnects       |
| B12 | `feat(draft): auto-pick — queue, then best-available-at-need` | Clock expiry always yields a legal pick             |
| B13 | `feat(draft): bot managers`                                   | Bots reuse B12 verbatim — one code path             |
| B14 | `feat(draft): slow draft timers`                              | 1h–24h picks, no real-time infrastructure           |
| B15 | `test(draft): 12-team simulation, humans + bots`              | 1000 drafts, zero invalid rosters                   |
| B16 | `feat(web): draft board, queue UI, pick flow`                 | A human can draft in a browser                      |
| B17 | `feat(draft): live draft room over WebSocket`                 | **Deferrable** — see cut list                       |

**B2 matters more than it looks.** Passing yards score 0.04/yard. In IEEE floats,
`0.04 × 25 !== 1`. Accumulate that across a 12-team season and matchups decided by
hundredths — which happens constantly — resolve wrong. All scoring is integer
milli-points internally; formatting to decimals happens only at the display edge.

---

## Milestone C — A season scores · target Sep 9 · **HARD**

| #   | Commit                                                    | Done when                                            |
| --- | --------------------------------------------------------- | ---------------------------------------------------- |
| C1  | `feat(season): round-robin schedule generation, 14 weeks` | Balanced, deterministic, no repeats beyond necessity |
| C2  | `feat(season): lineup set + validation`                   | Slot eligibility enforced from `slot_types`          |
| C3  | `feat(season): per-player lock at kickoff`                | A locked slot cannot move, ever                      |
| C4  | `feat(data): schedule-driven job runner`                  | Jobs fire off known kickoff times, no human trigger  |
| C4b | `feat(data): inactives job at kickoff −100min`            | Official inactive list lands before lineups lock     |
| C4c | `feat(data): game watcher + per-game finalisation`        | Polls from T+2.5h until `final`, then ingests        |
| C5  | `feat(data): stat_line revisions, append-only`            | Corrections never overwrite history                  |
| C6  | `feat(season): team-week scoring from lineups`            | Totals match hand calculation                        |
| C7  | `feat(api): SSE score stream`                             | Browser updates without refresh                      |
| C8  | `feat(season): matchup resolution + standings`            | W/L/T, Points For, Points Against                    |
| C9  | `feat(season): tiebreaker chain`                          | Deterministic to the final step, no coin flips       |
| C10 | `feat(season): deterministic autolineup`                  | Season-to-date average, ties by player ID            |
| C12 | `feat(web): matchup view, live scoring, standings`        | Sunday afternoon works                               |

---

## Milestone D — Escrow · written in week one, audited in parallel

Calendar-driven, not sequence-driven. Written alongside A and B.

| #   | Commit                                                       | Done when                                              |
| --- | ------------------------------------------------------------ | ------------------------------------------------------ |
| D1  | `chore(anchor): workspace, localnet, CI`                     | `anchor test` green on localnet                        |
| D2  | `feat(program): league account + rules hash + frozen config` | Rules hash immutable post-init                         |
| D3  | `feat(program): join with rules-hash acceptance`             | Consent provable on-chain                              |
| D4  | `feat(program): deposit to vault, single SPL token`          | Mixed tokens rejected at the type level                |
| D5  | `feat(program): unconditional timelock refund`               | **Funds can never be stuck. Ship first.**              |
| D6  | `feat(program): payout by frozen split`                      | 60/15/10/10/5 enforced by the program                  |
| D8  | `test(program): adversarial suite`                           | Double-deposit, early-withdraw, wrong-signer, overflow |
| D9  | `chore: upgrade authority → multisig, documented`            | Disclosed in README                                    |
| D10 | `chore: submit for audit`                                    | **Must happen in week one**                            |

---

## Milestone E — Rosters become NFTs · target Oct

Deliberately _after_ the season is running. A working season with database rosters beats
a broken season with beautiful tokens, and this is the most technically involved piece.

| #   | Commit                                                       | Done when                                     |
| --- | ------------------------------------------------------------ | --------------------------------------------- |
| E1  | `feat(program): Token-2022 mint, permanent delegate`         | Program can always move a roster token        |
| E2  | `feat(program): transfer hook restricting to league program` | Marketplace transfers rejected                |
| E3  | `feat(draft): mint "Player YYYY" on pick`                    | Draft produces wallet-held NFTs               |
| E4  | `feat(program): trophy unlock at settlement`                 | Transfer restriction relaxes after the season |
| E5  | `test(program): marketplace bypass attempts`                 | Every escape route provably closed            |

---

## Milestone F — Rosters change · target Sep 16 (waivers), Sep 20 (trades)

| #   | Commit                                            | Done when                                |
| --- | ------------------------------------------------- | ---------------------------------------- |
| F1  | `feat(txn): rolling waiver priority`              | Claim wins → team drops to the back      |
| F2  | `feat(txn): claim processing job`                 | Batch resolution, deterministic ordering |
| F3  | `feat(txn): 2-day waiver period then free agency` | Drops age correctly into FA              |
| F4  | `feat(txn): trade proposal + acceptance`          | Roster-legal trades only                 |
| F5  | `feat(program): trade escrow PDA`                 | Both sides' NFTs held atomically         |
| F6  | `feat(txn): 48h veto window + ⅓ threshold`        | Uninvolved teams only; bots abstain      |
| F7  | `feat(txn): veto resolution — execute or revert`  | Atomic both ways                         |
| F8  | `feat(txn): trade deadline enforcement`           | Week 11 hard stop                        |
| F9  | `feat(web): waiver + trade UI`                    | Usable without documentation             |

---

## Milestone G — The season resolves · target Dec–Jan

| #   | Commit                                             | Done when                               |
| --- | -------------------------------------------------- | --------------------------------------- |
| G1  | `feat(playoffs): seeding from final standings`     | Top 6, byes for 1–2                     |
| G2  | `feat(playoffs): bracket generation + advancement` | 3v6, 4v5, reseed, championship          |
| G3  | `feat(playoffs): consolation bracket`              | Bottom 6 seeded by finish               |
| G4  | `feat(data): second provider adapter`              | Independent source for oracle agreement |
| G5  | `feat(oracle): dual-source agreement gate`         | Disagreement freezes the week           |
| G6  | `feat(oracle): 48h / 7-day finalisation windows`   | Paying weeks wait out stat corrections  |
| G7  | `feat(settle): post finalised scores on-chain`     | Scores signed and stored                |
| G8  | `feat(settle): derive champion from bracket`       | No human declares a winner              |
| G9  | `feat(settle): execute payouts`                    | All five prizes distributed correctly   |
| G10 | `chore: burn upgrade authority`                    | Before Week 14 pays out                 |

---

## Milestone H — Seeker · target Jan–Mar 2027

Off the critical path for the 2026 season. Build against a proven backend rather than
alongside an unproven one.

| #   | Commit                                             | Done when                                                                                    |
| --- | -------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| H1  | `chore(mobile): RN + Expo bare workspace`          | Mirrors the `percolator-mobile` setup                                                        |
| H2  | `feat(mobile): Mobile Wallet Adapter + Seed Vault` | Biometric signing on Seeker                                                                  |
| H3  | `feat(mobile): league, matchup, roster screens`    | Feature parity with web for in-season use                                                    |
| H3b | `feat(mobile): how-scoring-works screen`           | Mirrors the web `/scoring` page. **Generate it from `NFL_PPR_SCORING`, never hand-write it** |
| H4  | `feat(mobile): draft room`                         | Drafting from a phone                                                                        |
| H5  | `feat(mobile): push notifications`                 | Veto windows and waiver results reach people                                                 |
| H6  | `chore: dApp Store submission`                     | Per `percolator-mobile/DISTRIBUTION.md`                                                      |

---

## If it slips

Cut in this order. Each line is a real season that still works.

1. **Live draft room (B17).** Slow drafts are popular and need no real-time
   infrastructure. Costs the least.
2. **Roster NFTs (E).** Run rosters in Postgres for 2026, mint for 2027. The season is
   unaffected; only the crypto-native story is.
3. **Trades (F4–F9).** A season with waivers but no trades is diminished, not broken.
4. **The pot.** Free leagues for 2026, money for 2027. Removes the audit from the
   critical path entirely and is the single largest risk reduction available.

Do **not** cut: scoring correctness, the rules hash, the timelock refund, or the
finalisation windows. Those are the ones that lose someone's money.

---

## Honest assessment

Milestones A and B in 17 days is achievable solo _if nothing else is attempted in
parallel_. Milestone C by Sep 9 is achievable. Milestone D written in the same window is
the strain — it's a different language, a different toolchain, and it must be good enough
to hand an auditor.

The plan assumes the team joins around Milestone B. If they don't, the pot is the thing
to cut, and cutting it early is far better than cutting it late.
