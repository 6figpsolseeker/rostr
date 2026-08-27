# League Rule Set

Every value in this document is **frozen at league creation** and can never be changed
for the life of that league. The full rule set is displayed to a prospective member
_before_ they join; joining is a signed transaction referencing the rule set hash.

The only permitted post-creation changes are:

- **Amend** — requires unanimous signed consent of every member holding a stake.
- **Dissolve** — unanimous consent, or automatic if the league never fills, refunding
  every member their original stake.

Anything not listed as league state below is a rule, and rules do not move.

|                                     |                                                                                                                                                                                                                           |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Rules** (frozen)                  | scoring, roster, league size, buy-in token + amount, payout split, draft type + timer + date, waiver system, trade deadline, veto threshold + window, playoff count, playoff weeks, tiebreaker order, commissioner powers |
| **State** (moves during the season) | rosters, standings, waiver order, matchup results, trade history                                                                                                                                                          |

---

## 1. Scoring — PPR

Set by the project owner. Standard modern full-PPR.

### Offense

| Event                                         | Points                       |
| --------------------------------------------- | ---------------------------- |
| Passing touchdown                             | **4**                        |
| Rushing touchdown                             | **6**                        |
| Receiving touchdown                           | **6**                        |
| Passing yards                                 | **0.04** per yard (1 per 25) |
| Rushing yards                                 | **0.1** per yard (1 per 10)  |
| Receiving yards                               | **0.1** per yard (1 per 10)  |
| Reception                                     | **1.0** (full PPR)           |
| Interception thrown                           | **−2**                       |
| Fumble lost                                   | **−2**                       |
| 2-point conversion (pass, rush, or reception) | **2**                        |
| Return touchdown                              | **6**                        |

No yardage milestone bonuses. Fumbles recovered by the fumbling team score nothing —
only **lost** fumbles are penalised, and the penalty is charged to the player who
fumbled.

**Return touchdowns** are kickoff, punt, and blocked-kick returns taken to the end zone,
scored by the returning player. Matches ESPN and Sleeper, which both treat this as a
category separate from the defensive unit's touchdown.

Interception and fumble returns are **not** this — they are defensive touchdowns, scored
by the Defense/Special Teams unit below. A single return touchdown therefore pays both
the returner and the opposing-of-that-play D/ST, which is correct: they are different
roster spots, usually owned by different managers.

### Kicking

| Event                  | Points |
| ---------------------- | ------ |
| Field goal 0–39 yards  | **3**  |
| Field goal 40–49 yards | **4**  |
| Field goal 50–59 yards | **5**  |
| Field goal 60+ yards   | **6**  |
| Extra point            | **1**  |
| Missed field goal      | **−1** |
| Missed extra point     | **0**  |

A missed field goal costs a point whatever its distance. This reversed an earlier
decision — misses used to score nothing, on the argument that penalising them punishes
the kicker for his coach's decision to attempt a 55-yarder. That argument still holds;
matching ESPN exactly won anyway, and a distance-independent penalty is also the only
form this data can support, because a miss is not a scoring play and no distance for it
reaches us.

Missed extra points are unpenalised, which is ESPN's default too.

### Defense / Special Teams

Scored as a single unit.

| Event                                 | Points |
| ------------------------------------- | ------ |
| Sack                                  | **1**  |
| Interception                          | **2**  |
| Fumble recovery                       | **2**  |
| Safety                                | **2**  |
| Defensive or special teams touchdown  | **6**  |
| Blocked kick                          | **2**  |
| Defensive two-point conversion return | **2**  |

A **defensive two-point conversion return** is a failed conversion attempt taken
back the other way by the defending team. ESPN's value, and Sleeper pays the same.
It happened three times across the 2024 and 2025 seasons, so it is rare rather
than theoretical.

**Points allowed**, awarded once per week on the unit's own game:

| Points allowed | Points |
| -------------- | ------ |
| 0              | **5**  |
| 1–6            | **4**  |
| 7–13           | **3**  |
| 14–17          | **1**  |
| 18–27          | **0**  |
| 28–34          | **−1** |
| 35–45          | **−3** |
| 46+            | **−5** |

**Yards allowed**, on the same unit and the same week:

| Yards allowed | Points |
| ------------- | ------ |
| Under 100     | **5**  |
| 100–199       | **3**  |
| 200–299       | **2**  |
| 300–349       | **0**  |
| 350–399       | **−1** |
| 400–449       | **−3** |
| 450–499       | **−5** |
| 500–549       | **−6** |
| 550+          | **−7** |

Both ladders are ESPN's. This table previously paid 10 for a shutout and bottomed out
at −4, and carried no yards ladder at all — so a unit that bent without breaking scored
identically to one that did not.

An earlier version of this section said points allowed "counts every point the opposing
team scores, including points scored by their defense and special teams". That was our
own rule and is not ESPN's; the sentence has been removed rather than reworded, because
the exact definition is ESPN's and is recorded with the alignment work in
`docs/TANK01.md`.

---

## 2. Roster

| Slot             | Count         |
| ---------------- | ------------- |
| QB               | 1             |
| RB               | 2             |
| WR               | 2             |
| TE               | 1             |
| FLEX (RB/WR/TE)  | 1             |
| K                | 1             |
| DEF              | 1             |
| **Starters**     | **9**         |
| Bench            | 5             |
| IR               | 2             |
| **Total roster** | **14 + 2 IR** |

IR slots hold only players officially designated out or on injured reserve, and do not
count against the roster limit.

**Lineup lock:** each slot locks individually at the kickoff of that player's game.
A player already locked cannot be moved for that week.

---

## 3. League

| Rule                    | Value                                               |
| ----------------------- | --------------------------------------------------- |
| Maximum teams           | **12**                                              |
| Minimum humans to start | **2**                                               |
| Bots                    | **At most one, and never in a league with a pot**   |
| Visibility              | **Private** (invite only) or **Public** (open join) |

### One bot, and only to square an odd number

A bot exists for a single situation: five friends who want to play and do not want a
stranger. Five teams is playable — the schedule gives somebody a bye each week — but that
is roughly three dead weeks per team across a season. One predictable opponent is better
than that.

So a bot may be added **only when the number of managers is odd**, and only **one**.
Adding one to an even league would create the bye it exists to prevent. The seat is a
placeholder: if a sixth friend turns up, the commissioner removes the bot and they take
it. That is possible right up until the draft order is drawn, after which the field is
locked for everyone.

### No bots in a league with a pot

**A bot cannot be paid.** It has no wallet and puts in no buy-in, so a bot finishing in a
paying position would leave that share with no recipient — on-chain, where there is
nobody to appeal to and nothing to undo.

Every rule that tries to handle it is more complicated than not allowing it. So
`maxBots` is **zero** in any league with a pot, it is part of the frozen rule set every
member signs, and league creation refuses the combination outright.

An odd-numbered pot league plays with byes.

### What a bot does and does not do

Bots draft and set lineups automatically for the whole season, using the same auto-pick
and autolineup a human gets when their clock expires. They **cannot propose or accept
trades, place waiver claims, or vote on a veto** — a bot with a vote is a commissioner
with extra steps.

---

## 4. Draft

**Snake order** — the order reverses each round. A team picking 1st in round 1 picks
12th in round 2, 1st in round 3, and so on.

### The order is drawn once, from the chain

The order is **not** drawn at league creation, and **not** drawn by us.

It comes from the first Solana block produced at or after the league's scheduled draft
time. That block does not exist while teams are still joining, so nobody — including the
commissioner and including us — can know the order in advance.

This matters more than it sounds. The shuffle depends on the seed _and_ on the set of
teams. If the seed were fixed in advance, a commissioner could add a bot, compute the
resulting order on their own machine, remove it, add a differently-named one, and repeat
until the order suited them. Every order they computed would be genuinely correct, and
the published one would look completely normal. They would simply have re-rolled in
private and announced the roll they liked.

So:

| Rule                          |                                                    |
| ----------------------------- | -------------------------------------------------- |
| **When**                      | At or after the scheduled draft time, never before |
| **From what**                 | The first Solana block at or after that instant    |
| **How many times**            | Once. The database rejects a second draw.          |
| **What happens to the field** | It locks at the draw. No team may join afterwards. |
| **Can positions be edited?**  | No. Rejected at the database level.                |

**Anyone can check it.** The slot and its blockhash are recorded and shown with the
order. Look up that slot on any Solana explorer, confirm its block time is at or after
the scheduled draft time and that the block before it is earlier — that makes it the only
block the league could have used — then recompute:

```
seed  = sha256("rostr:draft-order:v1:<leagueId>:<rulesHash>:<slot>:<blockhash>")
order = published snake shuffle over the team IDs in join order
```

The league ID and rules hash are mixed in so two leagues drawing from the same block get
unrelated orders.

Two modes, chosen at creation:

| Mode     | Pick clock                 |
| -------- | -------------------------- |
| **Fast** | 90s (minimum), 2m, 5m, 10m |
| **Slow** | 1h, 4h, 8h, 24h            |

**Queue and auto-pick.** Each manager keeps a personal ordered queue. When a clock
expires, the highest-ranked player on that manager's queue who is still available is
drafted. If the queue is empty or exhausted, the auto-pick falls back to the
**best available player at the team's most-needed position** — the same routine that
drives the bots.

The clock is hard. Expiry always results in a pick; a draft never stalls.

---

## 5. Season

| Weeks | Phase                         |
| ----- | ----------------------------- |
| 1–14  | Regular season                |
| 15    | Quarterfinals (seeds 1–2 bye) |
| 16    | Semifinals                    |
| 17    | **Championship**              |
| 18    | Unused                        |

Week 18 is excluded — NFL teams with settled playoff seeding rest starters, and a
championship cannot turn on a Sunday-morning inactive list.

**Head-to-head.** Each team plays one scheduled opponent per week. Higher PPR total
takes the win. Equal totals are a tie for both. Schedule luck is deliberate and
retained; there is no median scoring.

**The schedule is a seeded round robin.** It is generated from the league's rules hash
by the circle method, so anyone holding that hash can recompute the schedule and confirm
nobody arranged themselves an easy run. It depends only on the _set_ of teams and the
seed — never on join order, and never on the order rows come back from the database.

With 12 teams, the first 11 weeks are a complete round robin: everyone plays everyone
once. Weeks 12–14 begin a second rotation, so no pair meets more than twice. Home and
away are balanced to within one game per team.

**Odd leagues have byes.** A league can start with as few as two humans and bots are
optional, so an odd number of teams is legal. One team then sits out each week. A bye is
not a game: it contributes no win, no loss, and no points either way, so win percentage
stays comparable. Byes are distributed evenly — no team sits more than one extra time.

**Playoffs.** The top **6** of 12 qualify. Seeds 1–2 receive a Week 15 bye.

Those numbers describe a full league. Where fewer people joined than the league has
playoff places, every team that exists makes the playoffs and the byes are whatever that
field needs to form a valid round — five teams gives **three** byes, not two. The signed
`byeSeeds` is honoured wherever it can be, and a bye count sized for a league that never
filled would leave a round that cannot be paired at all.
Week 15 is 3v6 and 4v5; Week 16 pairs the top seed against the lower surviving seed;
Week 17 is the championship. Single elimination throughout.

**Every round reseeds.** The best surviving seed always draws the worst, which is what
makes a good regular season worth having. It also means the bracket cannot be drawn in
advance: who the top seed plays in Week 16 is not known until Week 15 is **final** —
scored is not enough, because a score inside the correction window can still change.

**A playoff bye is not a game.** A team on a bye has no fixture, sets no lineup, and
scores nothing that week. There is no way to be knocked out by sitting out.

**A tied bracket game goes to the higher seed.** The regular season keeps a tie as a tie
— it is a real result there — but somebody has to play the following week. The same rule
settles the championship and the third-place game.

**Third place is played, not awarded.** The two beaten semifinalists meet in Week 17, with
the better seed at home. A prize decided by anyone's judgement is the thing this project
exists to remove.

**Nobody declares a champion.** The bracket is derived from the posted scores every time
it is read; there is no stored winner and no endpoint that sets one.

**Consolation bracket.** The 6 non-qualifying teams play their own bracket across
Weeks 15–17, seeded by regular-season finish. It carries a real share of the pot
(see §7) and exists to keep eliminated teams engaged. A consolation field needing fewer
rounds than there are playoff weeks plays the **last** of them, so it still finishes in
Week 17 — the week its prize settles.

### Tiebreakers

Applied in order for seeding:

1. Win percentage
2. **Points For**
3. Head-to-head record — _skipped unless the tied teams played an equal number of times_
4. Points Against
5. Lowest team ID — your team's unique identifier, the same one §4's draft-order
   recipe shuffles. It is assigned at random when you join. It is **not** the order
   people joined in.

Step 5 is deterministic on purpose. No coin flips: the contract must be able to settle
without randomness when money is at stake.

It is also arbitrary on purpose. By the time it is consulted, the four criteria above
have said the teams are indistinguishable, so there is nothing left to measure — only a
tie to break in a way nobody can steer and anybody can check. Seniority was rejected for
that reason: ranking on join order would give whoever created the league the last word on
every tie it reaches, for as long as the league exists.

**Championship tie:** if both finalists score exactly equal totals in Week 17, the
higher seed wins.

---

## 6. Transactions

### Waivers and free agency

Matches ESPN. Every unrostered player is in exactly one of two states:

| State          | Meaning                                                             |
| -------------- | ------------------------------------------------------------------- |
| **On waivers** | Frozen. Claims are **blind** and all resolve together, by priority. |
| **Free agent** | Addable instantly, first come first served.                         |

#### The weekly cycle

| When (Eastern)                  | What happens                               |
| ------------------------------- | ------------------------------------------ |
| **Tuesday 00:00**               | Every unrostered player returns to waivers |
| **Wednesday 03:00**             | Claims process, blind, by priority         |
| Wednesday 03:00 → Tuesday 00:00 | Free agency, first come first served       |

This is the substance of the system, not the drop rule below it. A backup who
breaks out on Sunday is claimed by priority on Wednesday morning — not by whoever
happens to be refreshing on Sunday night.

#### Dropping a player

| Held for               | Goes to                 |
| ---------------------- | ----------------------- |
| **24 hours or more**   | Waivers                 |
| **Less than 24 hours** | Straight to free agency |

The short-tenure exception is ESPN's, and it exists to stop a manager adding a player,
cutting him hours later, and re-adding him to sidestep the claim queue.

#### Waiver period

**1 day.** A player clears at the first processing run at least a full day after landing
on waivers — so someone dropped on Tuesday evening does not clear the next morning,
which would leave the rest of the league no real chance to claim him.

#### Priority

- **Rolling.** Winning a claim sends that team to the back of the order.
- **A failed claim costs nothing.** Priority moves only on success, so there is never a
  reason to hoard claims.
- A team that wins several claims in one run moves once.
- Starting order is the **reverse of the draft order**.
- **Your own claims are tried in the order you filed them.** Priority decides every contest
  with another manager; filing order only decides which of _your_ claims gets your last
  roster spot. So file the player you want most first.

#### Locks

A player cannot be added or dropped once **his own game has kicked off**. Otherwise a
manager could cut an injured player mid-game, or add one after his touchdown.

#### Times are a timezone, never an offset

The schedule is stored as `America/New_York` plus a local hour. The season crosses the
daylight-saving change in early November, so a frozen UTC offset would shift every
waiver run by an hour partway through — around the trade deadline — with no symptom
other than claims resolving at the wrong time.

### Trades

Trades are **never automatic**. A trade moves through escrow:

```
propose → counterparty accepts → both NFTs move to the escrow PDA
        → 48h veto window opens
        → ≥ 1/3 of uninvolved managers vote against?
              yes → NFTs return to their origin wallets
              no  → escrow releases, rosters swap atomically
```

Bots neither vote nor trade. The threshold is one third of _uninvolved_ teams, matching
Yahoo's — deliberately harder to trigger than ESPN's majority, because leagues that veto
trades they merely dislike are miserable.

**A bot is not in the denominator.** Decided 2026-08-08. Bots cannot vote, so counting
them would make a league with one nearly un-vetoable — the threshold would rise while the
pool of possible voters did not. One third of uninvolved _managers_, not uninvolved teams.
In a 12-team league where two are trading, that is 4 of 10. In a 6-manager league with a
bot, it is 2 of 4.

**The commissioner has no veto override.** Every other platform gives one. This one does
not, and it is the same reasoning as everything else here: an administrator who can
reverse a result is the thing the project exists to remove. A trade the league does not
veto stands.

**Trade deadline: end of Week 11 by default, set by the commissioner at creation.**
Checked against ESPN on 2026-08-08: they publish a calendar date rather than a week, and
recent seasons landed around Weeks 12–13. Ours is deliberately a little earlier, and
frozen per league like every other rule. Necessary rather than traditional — without it,
an eliminated team can hand its roster to a contender it has a side arrangement with.
Any week from 8 to the end of the regular season may be chosen; validation refuses
anything outside that, so a league cannot be created with a deadline it has already
passed or one that never arrives.

**The deadline binds on the week a trade _executes_, not the week it was proposed.** A
trade accepted on the deadline still has a 48-hour window to sit through, so one accepted
late enough would otherwise land after the date the deadline names. Two checks, and both
are needed: a proposal is refused if the earliest week it could possibly execute in is
already past, and a trade whose window closes past the deadline **expires** rather than
executing — rosters untouched, nobody's fault, the state is `EXPIRED`.

**A player committed to an accepted trade is frozen** until it resolves. He cannot be
dropped, claimed away, or entered into a second trade. Without that, a manager could
accept a trade and cut the player they promised, and execution would find a hole where a
roster spot used to be. This is the database half of "both NFTs move to the escrow PDA",
and it holds whether or not the league has a pot.

**Rosters may change size.** A two-for-one is a normal trade; roster limits are a lineup
concern. Only a trade where one side gives nothing is refused, because a gift is how an
eliminated team hands its roster to a friend without anyone calling it a trade.

---

## 7. The Pot

Optional per league. When enabled:

- **One token per league**, chosen at creation. Every member deposits the identical
  amount in that token. Mixed-token pots are not supported: they are not a pot, they are
  an index fund with price risk, and there is no coherent definition of an equal buy-in.
- **For the 2026 season the token must have six decimals** — the stablecoin convention,
  and USDC is what this is built for. Base units are mint-specific, so without that
  restriction a single buy-in cap would mean a different amount of money for every token.
  A wider choice needs either a per-token cap or a price oracle; neither is worth building
  before the escrow has been reviewed.
- Funds lock in escrow until the championship resolves.
- **The buy-in is between $5 and $50 per member** while the escrow contract is young. A
  league stakes any amount in that range — $5, $10, $25, $47, $50 — the ceiling is a limit,
  not a price. At twelve members the most a single league can lose to a bug in new code is
  therefore $600.

  **Two things enforce that, and it is worth being exact about which does what**, because
  the dollar figure above depends on both. The _bounds_ are enforced by the program rather
  than the interface, so they bind every caller. The _token_ is set by this service, per
  network, and is not something a league creator supplies — which is what makes a bound
  expressed in base units mean a bound expressed in dollars. A cap of fifty on a token
  nobody chose deliberately is a cap of fifty of something, and the $600 above would not
  follow from it. The program checks the token has six decimals; it does not yet check
  which token it is, so a caller who bypasses this service entirely can still create a
  league denominated in another six-decimal token. Nobody can join or stake in such a
  league through rostr, and pinning the mint in the program is planned before mainnet.

  The floor is there because a pot has fixed costs a stake does not scale with: every
  deposit and refund is a transaction, the vault and each membership cost rent, and
  settlement pays every prize in the split. Below a few dollars, moving the money costs more than the
  money. A pot smaller than that is a free league with extra steps, and free leagues have
  their own path.

A league that plays for nothing is still a league: its rules are hashed on-chain and
members accept that hash to join, exactly as below. Only the escrow is skipped.

### The fee

**1% of the pot, taken once, at settlement.** Nothing is charged on deposit, and nothing
is charged on a refund.

Like every other rule here it is **frozen at creation and shown before anyone joins** — it
is part of the hashed document members sign. A fee the operator could change afterwards
would make "no administrator can rewrite the rules" untrue of the one party with the most
to gain from breaking it. The program enforces a hard ceiling of 5% on any league, so the
limit is in open-source code rather than in a promise.

**A refund under the timelock returns the full stake.** Withdrawing your own money must
never cost you a percentage; that escape hatch is what makes the escrow safe to ship
before it is audited, and a fee on it would weaken the guarantee for the sake of pennies.

For scale: DraftKings and Underdog rake around 10%, and LeagueSafe — an escrow service
that does none of the rest of this — charges 3–5%.

### Payout

The commissioner picks one of two shapes at creation. Both are frozen with everything
else, and in both the champion holds the largest single share.

**Split (default)**

| Prize                      | Share   | Decided by | Paid    |
| -------------------------- | ------- | ---------- | ------- |
| **Champion**               | **70%** | Week 17    | Week 17 |
| Runner-up                  | 20%     | Week 17    | Week 17 |
| Regular-season best record | 10%     | Week 14    | Week 17 |

**Winner takes all**

| Prize        | Share    | Decided by | Paid    |
| ------------ | -------- | ---------- | ------- |
| **Champion** | **100%** | Week 17    | Week 17 |

**Every prize is paid once, together, after the championship settles.** The
regular-season prize is _decided_ in Week 14 and _paid_ in January with the rest — decided
by then in the sense that matters, since the standings become final once Week 14's
correction window closes and nothing afterwards can move them.

This table used to say the regular-season prize settled in Week 14, and the change is
deliberate rather than a slip. **The contract pays in one transaction**, because a payout
split across several is how the vault ends up half-drained: a partial settlement leaves the
last members unable to take the timelock refund, permanently, and that refund is the
guarantee everything else here rests on. One transaction cannot pay a prize in December and
another in January, and the champion is not derivable until the Week 17 game finalises. So
the choice was two payouts with a way for money to become stuck, or one payout a month
later, and this is the second.

Nothing about the _result_ moves. The best regular-season record is still whoever held it
after Week 14, settled on Week 14's final numbers.

**Why no consolation or third-place share.** Both prizes depend on how many people
joined — a consolation bracket needs at least two teams left over, a third-place game
needs two semifinalists — while the payout is frozen before anyone joins. A payout naming
a prize the field turns out to be too small to award can never be completed, so the pot
never settles, and frozen rules mean it cannot be corrected. The consolation bracket is
still played; it just carries no share.

The split is not decoration. Under winner-take-all, a 2–9 team in Week 11 has no
remaining reason to open the app, and abandonment becomes the rational move. Paying the
consolation bracket and the regular-season record keeps every team playing for something
into Week 17.

### Settlement

No one declares a winner. The contract holds the bracket, the scores, and the rules, and
**derives** the champion from the Week 17 result. There is no commissioner sign-off, no
vote, and no discretion.

Stats reach the chain through an oracle, since no contract can observe an NFL game.
**That oracle is named in the rules you sign** — `pot.settlementOracle`, shown with the
buy-in and the payout split above the join control. It is the one trusted role in
settlement, and the honest thing is to let you see whose key it is rather than to leave it
unstated.

What it can do is post **scores**. The contract derives the champion, the runner-up and the
best record from them, so no instruction anywhere takes a winner. It cannot change a rule,
move a token, or pay anybody. If it never acts at all, every stake returns at the refund
unlock. It is frozen for the life of the league like everything else here, which means it
also cannot be swapped for someone else's key later.
Two independent providers must agree before a week's scores finalise; disagreement
freezes that week for review.

Finalisation is **two-tier**, because the NFL issues official stat corrections for up to
**seven days** after a game and a reclassified fumble can flip a matchup long after it
looked settled:

| Week                                  | Provisional | Final        | Why                                                                                                                                                     |
| ------------------------------------- | ----------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Regular season 1–13, playoffs 15–16   | immediately | **T+48h**    | Nothing is decided. The bracket advances only on finalised results, so a correction inside the window restates the round _before_ the next one is laid. |
| **Week 14** (regular-season prize)    | immediately | **T+7 days** | **Decides a prize.** Must outlast the correction window, even though the money moves later.                                                             |
| **Week 17** (championship, runner-up) | immediately | **T+7 days** | Decides a prize, and is the week the money moves.                                                                                                       |

**The long window follows what a week decides, not when it pays.** Week 14 settles the
best regular-season record and is paid in January with everything else, and it still waits
the full seven days — because once it finalises it is never rescored, so a correction
arriving on day three would otherwise land after the prize was fixed. Shortening it to 48
hours would decide 10% of the pot on numbers that were still provisional.

Weeks that decide nothing finalise in 48 hours so the season keeps moving. A correction
arriving after a deciding week has finalised does not reopen it — the seven days exist precisely so that never
needs to happen.

---

## 8. Autofill

**Nobody forfeits a stake for not showing up.** There is no abandonment rule, no strikes,
and no forfeiture. A manager who stops setting lineups is not defrauding anyone, and a
rule people would only discover by losing money to it is the wrong rule to have.

Instead, **a slot you leave empty gets filled for you**, and it is on by default. The fill
runs through the week and always before your week is scored. It never starts a player whose
own game has kicked off, so a slot you leave empty past a player's lock will not be filled
with him — the same rule that stops you starting him yourself.

**Selection is deterministic**, because a filled team's results move other people's
playoff seeds and, in a pot league, decide who gets paid.

**Who is eligible.** Every player on your active roster who can fill the slot. A player
stashed on IR is not — that is what the slot is for. **Nor is a player whose own game has
already kicked off**, because § 2's lock forbids moving him into a slot he was not already
in. The autofill is held to that lock exactly as you are: it may leave a player whose game
has started where he already stands, and it may not start him anywhere new.

**Who gets the slot.** Among those eligible, a player with a game this week who is not
ruled out comes first, because a player on a bye or officially out cannot score at all.
Then the highest-ranked of those, ties broken by ascending player ID. Scarce slots are
filled first, so a tight end who also qualifies for the FLEX is considered for TE first
rather than being taken by the FLEX and leaving TE empty.

**A slot with nobody eligible left stays empty** and scores nothing. That is the honest
outcome once everyone who could have filled it is already playing, and it is the better
one: an empty slot never locks, so it is still yours to fill from free agency with anyone
whose own game has not kicked off, where a started player would have locked it for the week.

**The ranking is that week's projection**, scored under this league's own frozen rules
rather than the provider's. A season average cannot know that this week's opponent is the
worst run defence in the league, or that the starter ahead of him is out. Where a player
has no projection — a rookie, or a week not yet published — his season-to-date average is
used **for him alone**; one gap must not decide how the other slots are filled.

Which of the two a league uses is frozen at creation, like every other rule.

> A projection is an opinion, and opinions could never pass the two-source agreement that
> § 7 requires before a week's scores finalise. That is the right bar for **facts** — did
> he score? — because two providers can disagree about what happened. Filling a slot is a
> **decision** standing in for the manager's own start/sit call, and nobody asks two
> providers to agree on one of those. The projection used is recorded with the lineup, so
> the decision is checkable after the fact.

**You can turn it off.** It is a per-team setting, not a league rule, so it is yours alone
and changeable whenever you like. Off means an empty slot stays empty and scores nothing —
which is the honest meaning of the switch, and why it is not the default.

Setting your own lineup always overrides it. Autofill only ever touches slots you left
empty, never a slot that has already locked, and never _puts_ a player whose game has
kicked off into a slot either.

---

## 9. Commissioner

Powers are bounded by the contract, not by convention. A commissioner with a stake in
the pot who can also move rosters is the obvious attack on this design.

**Permitted, before Week 1 only:** naming the league, scheduling the draft within the
creation-time window, adding and removing bots, inviting and removing members.

**Permitted at any time:** nothing that touches a roster, a score, a standing, or the
pot.

**Not permitted, ever:** editing rules, forcing or reversing trades, overriding vetoes,
setting another team's lineup, adjusting waiver order, or moving funds.

Everything a commissioner cannot do is either handled automatically by rule, or requires
a league vote.

---

## 10. Contingencies

Immutable rules must anticipate failure, because no one can patch them mid-season.

| Situation                                                       | Resolution                                                                                                                                     |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| An NFL game is cancelled or postponed beyond the scoring window | Affected players score 0 for that week. The matchup stands.                                                                                    |
| Both oracle providers disagree                                  | The week freezes pending review; no settlement occurs while frozen.                                                                            |
| Official stats are revised after posting                        | Absorbed by the finalisation window — 48h for non-paying weeks, 7 days for Weeks 14 and 17. Revisions after finalisation do not reopen a week. |
| A championship ends in an exact tie                             | Higher seed wins.                                                                                                                              |
| A league never reaches 2 humans by the draft date               | Auto-dissolve, full refunds.                                                                                                                   |
| A member disputes a result                                      | League vote. No commissioner discretion exists.                                                                                                |

The Bills–Bengals game of January 2023 was abandoned mid-game and never made up, during
fantasy playoff weeks, and every league in the country improvised. A league that cannot
be amended has to have the answer written down in advance.
