# Decisions

Why things are the way they are — including the options that were considered and
rejected. The rejected ones matter most: without them, the same proposals come back
around every few weeks.

Newest last within each section.

---

## Product

### Football first, but the schema never assumes football

Other sports are planned. Rather than promise a rewrite later, sports are registered as
data from the first commit: a set of stat keys, positions, and lineup slots.

**Cost of doing it now:** a few hours and one extra indirection.
**Cost of doing it later:** every table, every query, and the scoring engine.

### Full PPR only

One point per reception, 4 per passing TD, 6 per rushing/receiving TD, 1 point per 25
passing yards, 1 per 10 rushing/receiving yards, −2 per interception and lost fumble.
Kicker, DST, and two-point values follow league-standard defaults.

Nothing unusual — deliberately. A fantasy player should be able to join without reading
the scoring table.

### 12 teams, 2 humans minimum, bots fill the rest

Bots draft and set lineups. They cannot trade, claim waivers, or vote on vetoes — a bot
with a vote would be a commissioner with extra steps.

### Schedule luck is retained

**Rejected: median scoring.** Each team would play its normal head-to-head matchup _and_
take a second win or loss against the league median, which measurably reduces "I scored
the second-most points and still lost."

It was proposed precisely because money makes schedule luck feel worse. The owner
rejected it: every other fantasy league works the standard way, and matching player
expectations beats being marginally fairer.

### Rolling waiver priority, not FAAB

**Rejected for v1: FAAB** (a fake $100 budget, blind bidding). It is arguably fairer —
every team can win any player regardless of record, where rolling priority quietly
rewards losing.

Rejected anyway: it is opt-in on ESPN, Sleeper, and Yahoo, and default nowhere. Building
three waiver systems for v1 is a lot of surface area for a mechanic most leagues leave on
default. Reverse-standings priority is also deferred.

Note for later: FAAB maps unusually well to on-chain sealed-bid commit-reveal, which
makes it more trustworthy than any web2 implementation. Worth revisiting for 2027.

### Draft parity with ESPN and Sleeper

Checked deliberately, because a draft that behaves unexpectedly is the fastest way to
lose a league full of people who came from somewhere else.

**Where we match:**

| Behaviour                                       | Them              | Us                               |
| ----------------------------------------------- | ----------------- | -------------------------------- |
| Snake order, reversing each round               | Default on both   | Same                             |
| Draft order randomised before the draft         | Yes               | Yes, but seeded and reproducible |
| Personal queue drives auto-pick                 | Yes               | Same                             |
| Queue exhausted → best available by roster need | Sleeper, verbatim | Same                             |
| Hard timer always produces a pick               | Yes               | Same                             |
| Slow drafts (hours per pick)                    | Sleeper           | Same                             |

Sleeper's own wording for auto-pick — _"Once your queue is empty, the autopick will take
the next best player based on your roster needs"_ — is exactly what `autoPick()` does.

**Manual picks are permissive; auto-picks are protective.**

Neither platform stops you drafting a roster that cannot field a legal lineup — Sleeper
calls its version _"lazy enforcement"_, and ESPN offers optional per-position maximums
instead. An earlier version of this engine blocked such picks outright. That was wrong,
and the owner corrected it:

- **A manual pick is never blocked for being bad.** Nothing but wide receivers is a
  decision, not an error, and it belongs to the manager. `canDraft()` rejects only the
  genuinely impossible: roster full, or player already rostered.
- **Auto-pick will not strand a lineup on a manager's behalf.** When the clock expires,
  the manager was not there to choose — so `autoPick()` skips any player, queued or not,
  that would make the starting lineup unfillable.

The asymmetry is the whole point. Stakes are higher here than on ESPN: three consecutive
invalid lineups mean the team is abandoned and its stake forfeited. A manager may accept
that risk knowingly; the app must not impose it on someone who was asleep.

`pickWouldStrandStarters()` exists so the UI can warn before a manual pick confirms.
Warn, never block.

**The draft order seed is an unsolved security problem.**

The order is a seeded Fisher-Yates shuffle, so it is reproducible and auditable rather
than "trust us, it was random". But the output depends on the seed _and the set of team
IDs_, and anything a commissioner can vary before the draft, they can grind: add a bot,
compute the order, remove it, try another.

A seed fixed at league creation — the rules hash — does not close this. The seed must be
unpredictable until after the field is locked. **A Solana slot hash at or after the frozen
`draft.scheduledAt`** satisfies both halves: unknowable in advance, verifiable afterwards.

Until that is wired up, the order should be considered fair only for leagues without a
pot. Flagged in `order.ts` and in `SETUP-REQUIRED.md`.

**What we deliberately do not have:**

- **Per-position maximums** (both platforms offer them; off by default on ESPN, opt-in on
  Sleeper). Ours is a stricter, simpler guarantee instead.
- **Third Round Reversal**, a Sleeper variant where direction flips at round 3. A format
  option, not a default. Worth adding if leagues ask.
- **Auction and linear drafts.** Sleeper supports both. Snake only for v1.

### Consolation bracket pays out

Not a nicety — **the anti-abandonment mechanism.**

Under winner-take-all, a 2–9 team in Week 11 is mathematically eliminated and gets $0
whether they play or not. Punishing them for abandoning is empty; they have already lost
everything they can lose. Paying the consolation bracket means their record still sets
their seeding, and Week 11 still has money attached.

Payout is 60/15/10/10/5 — champion, runner-up, regular-season record, consolation winner,
third place. The champion must always hold the largest single share.

---

## Trust and governance

### Rules are immutable, and shown before joining

The rule set is hashed, the hash goes on-chain, the full document is pinned to IPFS, and
joining is a signed transaction referencing that hash. Consent is cryptographic rather
than a checkbox.

This is the feature web2 platforms cannot copy: their rules are a database row an admin
can edit.

**Escape hatches, deliberately narrow:** amendment requires unanimous signed consent of
everyone with a stake; dissolution is unanimous or automatic if the league never fills,
refunding everyone. Unanimity is safe _because_ it is nearly unachievable — the one person
being harmed always holds a veto.

### Commissioner powers are bounded by the contract

Every other platform resolves disputes with commissioner discretion, which is fine when
the prize is a group-chat crown. Here the commissioner would hold a stake in the pot
_and_ the ability to move rosters. That is the obvious attack.

Before Week 1 they may name the league, schedule the draft within the creation-time
window, and manage members and bots. After that they may touch nothing that affects a
roster, a score, a standing, or the pot.

### Every contingency is pre-written

Immutable rules cannot be patched mid-season, so the failure cases have to be answered in
advance: cancelled games, oracle disagreement, post-hoc stat corrections, championship
ties, leagues that never fill.

The precedent is real. The Bills–Bengals game of January 2023 was abandoned mid-game and
never made up, during fantasy playoff weeks, and every league in the country improvised.

### The final tiebreaker is deterministic

Every major platform ends its tiebreaker chain with a coin flip. Fine for bragging
rights; unacceptable when the contract has to settle. The chain ends on lowest team ID.

---

## Chain

### Mainnet, with the pot live, for the 2026 season

**Rejected: devnet.** Solana devnet is periodically reset, and a fantasy season runs five
months. A league starting in September could lose its on-chain state before December.

**Also considered: mainnet with the pot disabled for 2026**, enabling money in 2027 once
audited. That removes the audit from the critical path entirely and is the single largest
available risk reduction.

The owner was shown both and chose to ship with the pot live. Consequences designed around
rather than argued with:

1. **An unconditional timelock refund from day one.** After a hard date, any member can
   withdraw their own stake unilaterally regardless of what else is broken. Funds can
   never be permanently stuck.
2. **Upgrade authority on a multisig**, disclosed in the README.
3. **Buy-in cap** for the first season.
4. **Burn the upgrade authority** once settlement is audited, before Week 14 pays out.

The audit is the long pole — 2–4 weeks of calendar time — so the escrow program is written
in week one despite not paying out until January.

### Roster NFTs are the roster, not souvenirs

Drafting a player mints a Token-2022 NFT labelled `Player YYYY` to the manager's wallet.
Holding it is what puts the player on the roster.

This forces a specific design. A freely transferable NFT could be sold on any marketplace,
bypassing the league entirely and making the veto decorative. So:

- **Transfer Hook** — every transfer calls back into the league program, which rejects
  anything that is not an approved league transaction
- **Permanent Delegate** — the program can always move a token, which is what makes
  waivers, vetoed-trade reversal, and abandoned-team dispersal possible at all

**Rejected: compressed NFTs.** Far cheaper per mint, but cNFTs do not support Token-2022
extensions, and without those the transfer restrictions are unenforceable.

At season end the transfer restriction relaxes and the NFT becomes a freely tradeable
trophy.

### Trades escrow, then a veto window

Propose → accept → both NFTs move to an escrow PDA → 48h window → if at least one third of
uninvolved teams vote against, the NFTs return; otherwise the swap executes atomically.

One third matches Yahoo's threshold, deliberately harder to trigger than ESPN's majority.
Leagues where people veto trades they merely dislike are miserable — the near-universal
etiquette is to veto collusion, not bad trades.

### Settlement is derived, not declared

Nobody signs "team 7 won." The contract holds the bracket, the scores, and the rules, and
derives the champion from the Week 17 result.

The irreducible part is that no contract can watch an NFL game, so stats reach the chain
through an oracle. That is a much better-shaped trust assumption than a human picking a
winner: two independent providers must agree before a week finalises, and disagreement
freezes it.

---

## Data

### Per-game score updates, not real-time

Scores refresh when each game finishes — five or six updates a weekend.

Live scoring is **pure UX**: matchups need only end-of-week totals, and the chain sees
only finalised scores. No rule changes as a result.

**The reason is not cost.** Tank01 updates box scores as they happen and 30-second polling
fits inside the $10/month tier. The reason is build time and operational surface in a
35-day window. The fetch interval is a config value, so this is reversible any Sunday.

What it costs: watching a score tick up during the 1pm slate is why people open a fantasy
app forty times on a Sunday. Users are watching on TV, which runs _ahead_ of every feed.
Accepted trade.

### Two providers, for two different reasons

- **Tank01 Pro, $10/mo** — box scores, stats, news, weekly injury designations
- **SportsDataIO, $99–149/mo** — the independent second oracle source **and** gameday
  inactives

The second line item earns its cost twice. Tank01 refreshes rosters (and injuries with
them) hourly, which is fine for Wednesday–Friday injury reports but weak for inactives:
those drop 90 minutes before kickoff, so users would see them anywhere from T−90 to T−30.
SportsDataIO documents an explicit `Inactive` field at ~90 minutes.

**Inactives matter more than live scoring.** They change what users _do_; live scoring
only changes what they _watch_.

**Rejected: ESPN's undocumented public endpoints.** Free and comprehensive, and they are
what ESPN's own apps run on. But they are unversioned, unsupported, undocumented, can
change without notice, and commercial use likely violates ESPN's terms. Fine for
development fixtures and as a human tiebreak signal; never in the automated path that
decides who gets paid.

### Data cost is O(games), not O(users)

One box score is fetched and scored against every league in the system. Ten leagues or ten
thousand, the API bill is identical. Data spend is fully decoupled from growth.

---

## Identity

### Email plus wallet

A wallet is an address, not a person. Display names and invite flows need an identity that
exists before someone opens the app.

**Rejected: IP-based duplicate detection.** It was specifically asked about. Three
problems, in order of severity:

1. **It breaks real users.** Fantasy leagues are built from friend groups, roommates,
   families, and dorms — all sharing an IP, all exactly who should be in a league
   together.
2. **It stops nobody.** Airplane mode gives a new IP. Any VPN defeats it in seconds.
3. **IP addresses are personal data** under GDPR and CCPA, bringing compliance obligations
   a side project does not want.

What is actually being defended against is not sybil — every extra wallet pays another
full buy-in and still cannot win twice — but **collusion**, which the trade veto already
addresses and which is detectable from behaviour rather than network address.

IPs are logged as a review signal, never as a gate.

---

## Engineering

### Integer milli-points, never floats

Scoring is integer milli-points (1 point = 1000), percentages basis points, thresholds
explicit numerator/denominator pairs, token amounts decimal strings.

`canonicalize()` throws on any non-integer number. This is not a lint rule to be argued
with — it is what makes hash drift impossible by construction rather than by discipline.

A single product often survives IEEE 754 intact (`0.04 * 25` really is `1`). Accumulation
is where it fails, and a season is nothing but accumulation.

### Canonical encoding is defined here, not delegated

`JSON.stringify` orders keys by insertion. Two code paths that build the same rule set in
different orders would produce different hashes, so encoding is specified explicitly:
sorted keys, no whitespace, integers only, `undefined` rejected rather than silently
dropped.

Pinned by a golden fixture test, checked across Node majors in CI.

### Field goals are buckets, not tiers

Kicker scoring varies by distance, which looks like a tiered rule. Modelling it that way
would require the scoring engine to see individual kick events.

Instead the provider adapter emits three ordinary counters — `fg_0_39`, `fg_40_49`,
`fg_50_plus` — each with a flat multiplier. Complexity stays in the adapter and the engine
keeps one uniform shape. Defensive points allowed remains the only genuinely tiered stat.

### Vertical slices, and the calendar as a release schedule

Settlement code does not run until January. Playoff brackets do not run until December.
Waivers do not run until Week 2. Only drafting (Aug 22) and scoring (Sep 9) are genuinely
due in the next five weeks.

That turns an impossible 35-day scope into a feasible one, provided the ordering respects
it. Building settlement in August would be building it instead of the draft.
