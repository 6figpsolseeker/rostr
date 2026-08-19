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

### Consolation bracket is played, but no longer paid

Not a nicety — **it is what keeps a losing team playing.**

Under winner-take-all, a 2–9 team in Week 11 is mathematically eliminated and gets $0
whether they play or not, so there is no reason left to open the app. Paying the
consolation bracket means their record still sets their seeding, and Week 11 still has
money attached.

This used to be framed as the anti-abandonment mechanism, paired with a rule that took a
stake from anyone who stopped showing up. That rule is gone (below), so this now carries
the whole job — which is the better arrangement anyway: giving someone a reason to play
beats punishing them for not.

**Superseded 2026-08-10.** The reasoning above still stands, and the bracket is still
played for exactly that reason — but it no longer carries a share, because it could not
safely carry one.

A consolation bracket needs at least two teams left over, so it does not exist below
eight members at six playoff places; a third-place game needs two semifinalists, so it
does not exist below four. The payout is frozen and signed before anyone joins, while
the bracket's shape is not known until the field locks. Paying a prize the field may
turn out to be too small to award meant `championship().complete` could never become
true — the pot never settled, and frozen rules meant it could not be corrected.

So the payout is now built only from prizes decidable at any size: **70/20/10** on
champion, runner-up and best regular-season record, or **winner-take-all**, chosen by
the commissioner at creation. The champion still holds the largest single share.

Winner-take-all is offered despite the argument above, as an option a commissioner
picks deliberately rather than a default anyone lands on.

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
rights; unacceptable when the contract has to settle. The chain ends on lowest team ID —
`teams.id`, the random UUID, sorted ascending.

**Rejected: join order.** The obvious reading of "team ID" is a 1..N number, and
`teams.slot` is exactly that. Ranking on it is worse than the arbitrariness it removes.
`slot` is `count(*) + 1` at join, so the lowest belongs to whoever joined first — in
practice the commissioner, who holds the league URL before anyone else has seen it. That
makes the last word on every unresolved tie, and the 1000 bps regular-season prize hanging
off seed 1, a standing property of having created the league. It is the same special power
the rest of this system is built to delete, arriving through a column nobody thinks of as
a permission.

**Rejected: a key derived from the draft-order seed.** Attractive because the seed is
already unpredictable and already published, so the tiebreak would be unguessable at
formation and checkable afterwards. It closes nothing: a v4 UUID is equally unchooseable
and equally checkable, and the seed becomes public at the draw either way. It costs a
league-identity parameter threaded through a pure function that deliberately has none, a
fallback for the pre-draw state it was meant to replace, and — since the value would no
longer be a team id — either a rename that moves the golden hash and breaks every anchored
league, or a name that lies about what the code does. That last is the defect this decision
exists to correct, so paying for it with a fresh instance of it is not a trade.

**Arbitrary is the requirement, not a concession.** Four real criteria have already found
the teams indistinguishable. What is left is not a question about football, and inventing a
measurement to answer it would be worse than admitting that. The bar is that it terminates,
that anyone holding the standings can reproduce it, and that no participant can steer it.

Note what this branch actually does in practice. Deciding money needs exact equality on win
percentage, points for, head-to-head and points against — order 10⁻⁸ per league-season. But
with no games played every team is equal on all four, so it orders the **entire league on
every pre-season standings view**. The visible behaviour is common and the paying behaviour
is vanishingly rare, which is why this is documented carefully and not engineered heavily.

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

> **Superseded 2026-08-19 — not the plan any more.** Kept because the reasoning below
> is still correct _given its premise_, and the premise is the thing that changed. See
> "A weekly card, claimed by whoever rostered him" at the end of this section.

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

### A weekly card, claimed by whoever rostered him

**A possibility, not a decision.** Nothing here is built, nothing is scheduled, and the
whole thing can be dropped without anything else moving. Recorded on 2026-08-19 so the
reasoning is not re-derived from scratch, because most of it was arrived at the hard way.

One NFT per league per week, for the player who scored the most PPR points that week.
You are eligible if you **owned him on your roster** when the week finalised — started
or benched makes no difference. Seventeen a season instead of a hundred and sixty-eight
per league.

**What changed the premise.** The design above needs a transfer hook and a permanent
delegate for one reason: if holding the NFT _is_ what puts a player on your roster, a
freely sellable NFT lets someone bypass the league. Make the NFT cosmetic and that entire
problem disappears — nobody bypasses a league by selling a souvenir. The database stays
the source of truth it already is.

That is also what reopens compressed NFTs, rejected above for not supporting Token-2022
extensions. Correct, and no longer disqualifying: with nothing to enforce, there is
nothing those extensions were needed for.

**Why weekly-and-claimed beats mirroring the roster.** A roster is a verb. Players are
dropped, claimed and traded, so an NFT minted at the draft is wrong by week three, and
keeping it right means an on-chain side effect on every roster path — which cannot live
inside the transaction, since a lock must not be held across an RPC round trip. A weekly
award has no such problem: _Mahomes put up 41.2 in week seven_ is true forever.

**Decided, if it is ever built:**

- **Eligibility is a snapshot at `finalized_at`**, recorded then and never recomputed.
  Reading the live roster at claim time would take a card off a manager who dropped him
  in week nine and had already earned it, and hand one to whoever picked him up.
- **Never decide before the week finalises.** Stat corrections land for up to seven days
  and can change who led the week; an immutable card naming the wrong player has no
  remedy. Hangs off the same gate the bracket does.
- **One card per league**, a 1 of 1 within its own league. Rostered in forty leagues is
  forty cards, and that is fine — nobody experiences the product globally.
- **Claims close three weeks after the league ends**, so one deadline covers all
  seventeen weeks rather than seventeen rolling ones.
- **No player photograph.** Not a stylistic preference. Fantasy's legal footing is
  [CBC v. MLBAM](https://www.quimbee.com/cases/c-b-c-distribution-and-marketing-inc-v-major-league-baseball-advanced-media-l-p),
  which protects **names and statistics** — CBC's product had no images and the ruling
  addresses none. Photographs carry three separate rights (the photographer's copyright,
  the player's publicity right through the NFLPA, the team's trademark), and none is
  cleared by giving the token away: NFLPA v. Leaf is live over exactly this, and
  DraftKings shut down Reignmakers and settled rather than fight it. Pixelating does not
  help — that is a derivative work, and _Warhol v. Goldsmith_ (2023) closed the
  transformative-use argument for a far better artist than us.

  The card is therefore built from name, position, team colours, jersey number and the
  box score — which is the protected category, and is also the only version that never
  breaks. Our own headshot URLs are wrong or missing for 361 of 4,202 players.

- **The real reason to care is not the odds of being sued.** They are ~0 at this size.
  It is that a webpage can be deleted and a minted token cannot. Nothing goes on-chain
  that we would be unable to withdraw.

**Still open:** ties. Two players on the same milli-point total, one card, and it needs
a deterministic rule written before the first mint — the same argument that makes
`computeStandings` throw rather than fall back to row order.

**Rejected: mirroring the roster into the wallet.** Mint on acquire, burn on drop, move
on trade. Workable via a reconciler diffing `roster_entries` (append-only, so the
desired state is one query) but it needs a signing key of ours, it makes a stale wallet
into a false record, and it is six commits against two.

**Rejected: one NFT per team with updating metadata.** Solves the churn problem — one
token, edited — but it is a dashboard rather than a keepsake, and nobody wants a
souvenir that changes.

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

### The bracket is recomputed, never accumulated

Decided 2026-08-08, while building it. The obvious implementation stores who advanced —
a `winner_team_id` on each bracket game, read to build the next round. It is wrong for the
same reason a stored champion would be: NFL stat corrections arrive for up to a week, so a
Week 15 result can genuinely change after Week 16 has been drawn, and a stored winner
would then disagree with the score it came from with nothing to reconcile them.

So `buildBracket` walks the ladder from round one on every call. At this size it costs
nothing, and it makes the bracket a function of two inputs anyone can check: the seeded
field and the posted scores.

The visible cost is that fixtures appear one round at a time. That is not a limitation
being worked around — every round reseeds, so who the top seed plays next week is not
knowable until this week is scored. A screen that drew Week 16 in advance would be
inventing it.

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

**A bot can win.** The champion takes the largest share of the pot. A bot has no wallet and paid no
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
