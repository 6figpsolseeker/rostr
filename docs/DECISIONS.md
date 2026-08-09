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

The asymmetry is the whole point. A roster that cannot field a legal lineup is a season
of empty slots scoring nothing, in a league where those results move other people's
playoff seeds. A manager may accept that knowingly; the app must not impose it on someone
who was asleep.

`pickWouldStrandStarters()` exists so the UI can warn before a manual pick confirms.
Warn, never block.

### The draft order is drawn from the chain, once

**Solved.** It was the one genuinely exploitable hole in the design, and it deserves
recording in full because the fix looks like overkill until you see the attack.

The order is a seeded Fisher-Yates shuffle: reproducible and auditable, rather than
"trust us, it was random". But the output depends on the seed **and the set of team
IDs**, and anything a commissioner can vary before the draft, they can grind:

1. Add a bot. Compute the order on your own laptop. Seventh — no good.
2. Remove it, add a differently-named one. Compute again. Fourth.
3. Repeat until first. Open the draft.

Every order computed along the way is genuinely correct. The published one looks
completely normal, because nothing was tampered with — they re-rolled in private and
announced the roll they kept. **No server-side check can detect this**, because the
grinding never touches our servers.

A seed fixed at league creation — the rules hash, say — does not help. Neither does a
better shuffle. The seed itself has to not exist while the field can still change.

**The rule: the first Solana block produced at or after the frozen `scheduledAt`.**
Unknowable while teams are joining; verifiable by anyone afterwards; not ours to choose.

Four mechanisms, each closing a different way back in:

| Mechanism                                           | What reopens without it                                      |
| --------------------------------------------------- | ------------------------------------------------------------ |
| Refuse to draw before `scheduledAt`                 | Drawing from a block the field can still be arranged against |
| Rule names the **first** such block, not any        | "Try again a few slots later" until the order suits you      |
| Trigger rejects a second draw or an edited position | Redrawing, or just editing the result                        |
| Trigger locks the field at the draw                 | Watch the block land, then add a bot that shifts the order   |

**This did not need Anchor.** Reading a block hash is a plain JSON-RPC call; only
verifying one _inside a program_ needs Rust. That was worth noticing — the fix had been
parked behind the escrow work for no reason.

Rejected along the way:

- **A commit-reveal between members.** Stronger in theory, but it needs every manager to
  show up twice before a draft they have not started yet. Nobody would.
- **Our own server-side RNG with a published seed.** Just relocates the trust to us, which
  is the thing this project exists not to require.
- **A slot number committed at league creation.** Slot times drift; a slot chosen weeks
  ahead could land hours off the scheduled draft. Time-based is exact and just as
  checkable.

**Known limit:** public RPC nodes prune old blocks, so verifying a draw months later needs
an archival node. Recorded in `SETUP-REQUIRED.md` rather than left to be discovered during
a playoff dispute.

**What we deliberately do not have:**

- **Per-position maximums** (both platforms offer them; off by default on ESPN, opt-in on
  Sleeper). Ours is a stricter, simpler guarantee instead.
- **Third Round Reversal**, a Sleeper variant where direction flips at round 3. A format
  option, not a default. Worth adding if leagues ask.
- **Auction and linear drafts.** Sleeper supports both. Snake only for v1.

### Consolation bracket pays out

Not a nicety — **it is what keeps a losing team playing.**

Under winner-take-all, a 2–9 team in Week 11 is mathematically eliminated and gets $0
whether they play or not, so there is no reason left to open the app. Paying the
consolation bracket means their record still sets their seeding, and Week 11 still has
money attached.

This used to be framed as the anti-abandonment mechanism, paired with a rule that took a
stake from anyone who stopped showing up. That rule is gone (below), so this now carries
the whole job — which is the better arrangement anyway: giving someone a reason to play
beats punishing them for not.

Payout is 60/15/10/10/5 — champion, runner-up, regular-season record, consolation winner,
third place. The champion must always hold the largest single share.

### Abandonment removed; the autofill does the job instead

Decided 2026-08-08, schema 3 → 4.

**The rule could not fire.** It counted consecutive weeks with an _invalid_ lineup, but
`ensureLineups` autofills every team before a week is scored, so a lineup is never invalid
at the moment the count would happen. `teams.strikes` existed and nothing incremented it.

It could have been given a workable trigger — weeks where the manager set nothing and the
autofill did it for them. It was removed instead, and the reasoning is worth keeping:

**Forfeiting a stake for inattention is the wrong rule.** A manager who stops setting
lineups is not defrauding anyone. They are busy, or bored, or their team is 2–9. The
league is not harmed either, because the autofill keeps their team competitive — which is
the actual concern, and it is already solved. What abandonment added on top was a penalty
people would discover by losing money to it.

**It deletes an escrow instruction.** D7, "abandonment forfeit to champion", would have
moved one member's stake to another based on a strike count, in a program shipping without
a commercial audit. Deleting a path that moves money is worth more than hardening one.

**Rejected: keep it, with a better trigger.** The trigger was fixable; the rule was not
worth fixing.

**Rejected: keep strikes as warnings without forfeiture.** Warnings nobody acts on are
noise, and the on-chain warning at strikes 1 and 2 was only ever there because money was
at stake at strike 3.

### The autofill ranks on projections, and that is allowed

Same change. The autofill previously used season-to-date average and `RULES.md` explicitly
refused projections, on the grounds that a provider changing its model would alter the
outcome of a rule that can never be amended.

That objection is answerable and was over-weighted. Store the projection used, with its
source, and the decision is as reproducible as anything else in the system.

The sharper distinction is **fact versus decision**. Settlement requires two independent
providers to agree before a week finalises, and that is right for facts — did he score? —
because two sources can disagree about what happened. Projections are opinions and could
never pass that gate. But filling an empty slot is not a fact, it is a **decision**
standing in for the manager's own start/sit call, and nobody demands two providers agree
on one of those either.

So a projection may decide a lineup and may never decide a score. A season average is the
per-player fallback where no projection exists, and the whole-league alternative if a
league wants one.

**Weekly, not season.** `player_projections` already held projected season totals for the
draft board, which cannot answer "who scores most this Sunday" — a player on bye projects
zero for the week and unchanged for the season. Migration `0015` adds `week` to the key,
with week 0 meaning the season aggregate so the draft board is untouched.

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

### The fee is 1%, and it lives inside the rules it is charged under

Decided 2026-08-07. One percent of the pot, taken once, at settlement.

**The rate matters less than where it lives.** It is a field in the hashed rule set —
`pot.feeBps` and `pot.feeRecipient` — frozen at league creation and signed by every member
who joins. A fee held in our configuration instead would be a number we could change after
people had committed money, which would make "no administrator can rewrite the rules" false
of the one participant with the most to gain from breaking it. The program also enforces a
5% ceiling on any league that can ever be created, so the limit is in open-source code
rather than a promise.

**Charged at settlement, not on deposit.** A deposit-time cut is a toll on entry, and it
makes the refund question ambiguous — if a member withdraws under the timelock, was the fee
already taken? At settlement the pot is a known quantity and the arithmetic is clean.

**Never charged on a refund.** Withdrawing your own stake under the timelock returns it in
full. That escape hatch is the reason the escrow is shippable before it has been reviewed,
and taking a percentage of it would weaken the guarantee for the sake of pennies.

**Why 1% and not 0.5%.** Both are far below the market — DraftKings and Underdog rake
around 10%, and LeagueSafe, which provides escrow and none of the rest of this, charges
3–5%. At the $50 buy-in cap a full 12-team league pays $6. Running costs are $135–185/month,
so 1% breaks even at roughly fifteen full leagues a month and 0.5% at thirty. The lower
number buys very little additional goodwill against a figure already an order of magnitude
under the incumbents, and 1% is still a sentence you can say out loud without flinching.

**Rejected: a flat per-league fee.** Simpler to explain, but it falls hardest on the
smallest leagues — a $5 flat fee is 10% of a two-person $50 pot and 0.8% of a twelve-person
one. A percentage is neutral to league size, which matters when the product is aimed at
existing friend groups rather than whales.

### Free leagues are anchored on-chain too

A league with no pot has nothing to escrow, so it was tempting to let it skip the chain
entirely and keep its rules in Postgres.

That would have made the central claim conditional. "The rules are immutable and you can
verify them" would hold only for leagues with money in them; everyone else would be trusting
a database row we control, which is exactly the arrangement this project exists to replace.
The cheaper guarantee is also the one most people would meet first, since free leagues are
how anyone sane tries a new platform.

So `initialize_free_league` writes the same `League` account with the same rules hash, no
vault and no buy-in. It is a separate instruction rather than a flag because the account set
genuinely differs — making the mint and vault optional would let a caller create a pot
league that can never accept a deposit.

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

#### The deadline binds on execution, not on proposal

Decided 2026-08-08, while building it. The obvious implementation checks the deadline when
a trade is proposed, and it is wrong in a way that only shows up in week 11: an accepted
trade sits in a 48-hour veto window, so one accepted late enough executes after the date
the deadline names. The deadline exists to stop an eliminated team handing its roster to a
contender, and a trade that lands in week 12 does exactly that however it was timed.

So there are two checks. At proposal, against the earliest week the trade could possibly
execute in — which is a floor, not a guarantee, because a trade left unaccepted for days
slides past it. And at resolution, against the week the window actually closed in, where a
trade past the deadline **expires** rather than executing.

Expiring rather than executing-anyway was the choice, and the alternative — refusing to
accept once the window would close late — was rejected because it makes the last few days
before the deadline behave differently from every other day for no reason a manager could
predict. Expiry is visible, states it plainly, and touches nobody's roster.

The corollary is `currentWeek()` in `packages/db/src/week.ts`. The week has to come from
the schedule, server-side: a deadline checked against a week the client sent is not a
deadline, because anyone can post `week: 1` in January.

#### Accepting freezes the players

Between acceptance and execution the players are committed. In the on-chain design that is
literal — both NFTs sit in an escrow PDA — and the database has to give the same guarantee
for leagues without a pot, or the rule would only hold where there is money.

Without it the attack is trivial and does not even look like one: accept a trade, drop the
player you promised, and the swap executes into a roster spot that no longer holds him.
`lockedByTrade` is consulted by dropping and by proposing, so a committed player cannot
leave by any path.

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

### One bot per league, and none where there is money

**Decided 2026-08-08.** Bots previously filled any number of unclaimed slots, up to
twelve, in any league.

The owner's instinct was that bot-heavy leagues make bad trades, or cannot judge a trade
offered to them. That specific worry was already handled — `RULES.md` §6 has always said
bots neither vote nor trade, so a bot cannot be offered one. What the review found instead
was worse and unhandled:

**A bot can win.** The champion takes 60% of the pot. A bot has no wallet and paid no
buy-in, so a bot champion leaves that share with no recipient — on-chain, where there is
nobody to appeal to. Two smaller versions of the same thing: bots occupy playoff places
without staking, and a bot's roster decays (no waivers, no trades, no injury reactions)
so playing one is a near-free win, which weeks 12–14 distribute unevenly.

Three options were weighed:

| Option                                     | Why not                                                        |
| ------------------------------------------ | -------------------------------------------------------------- |
| Bot ineligible for prizes, share passes on | Works, but every payout rule then carries an exception         |
| Bar bots from the playoffs                 | Arbitrary — a bot could have the best record                   |
| **No bots in pot leagues at all**          | **Chosen.** The case cannot arise, so nothing has to handle it |

The owner chose the third, and it is the right one: it removes the problem rather than
managing it, and the escrow program never has to know what a bot is.

**One bot, and only when the count is odd.** A bot exists to square five friends. The
schedule already handles odd leagues with byes — that is roughly three dead weeks per
team, which is worse than one predictable opponent, so the bot earns its place. More than
one is a different product.

`botsAllowed: boolean` became `maxBots: number` in the same change. The boolean was in the
frozen rule set and **enforced nowhere** — a guarantee members signed that did nothing.
One field also cannot disagree with itself the way "allowed" and "how many" can.
schemaVersion 2 -> 3.
