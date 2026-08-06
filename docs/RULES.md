# League Rule Set

Every value in this document is **frozen at league creation** and can never be changed
for the life of that league. The full rule set is displayed to a prospective member
_before_ they join; joining is a signed transaction referencing the rule set hash.

The only permitted post-creation changes are:

- **Amend** — requires unanimous signed consent of every member holding a stake.
- **Dissolve** — unanimous consent, or automatic if the league never fills, refunding
  every member their original stake.

Anything not listed as league state below is a rule, and rules do not move.

|                                     |                                                                                                                                                                                                                                               |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Rules** (frozen)                  | scoring, roster, league size, buy-in token + amount, payout split, draft type + timer + date, waiver system, trade deadline, veto threshold + window, playoff count, playoff weeks, tiebreaker order, abandonment policy, commissioner powers |
| **State** (moves during the season) | rosters, standings, waiver order, matchup results, trade history, strike counts                                                                                                                                                               |

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
| Field goal 50+ yards   | **5**  |
| Extra point            | **1**  |
| Missed field goal      | **0**  |
| Missed extra point     | **0**  |

Misses are not penalised. Penalising them is a common house rule but punishes the
kicker for his coach's decision to attempt a long field goal.

### Defense / Special Teams

Scored as a single unit.

| Event                                | Points |
| ------------------------------------ | ------ |
| Sack                                 | **1**  |
| Interception                         | **2**  |
| Fumble recovery                      | **2**  |
| Safety                               | **2**  |
| Defensive or special teams touchdown | **6**  |
| Blocked kick                         | **2**  |

**Points allowed**, awarded once per week on the unit's own game:

| Points allowed | Points |
| -------------- | ------ |
| 0              | **10** |
| 1–6            | **7**  |
| 7–13           | **4**  |
| 14–20          | **1**  |
| 21–27          | **0**  |
| 28–34          | **−1** |
| 35+            | **−4** |

Points allowed counts every point the opposing team scores, including points scored by
their defense and special teams.

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

| Rule                    | Value                                                                     |
| ----------------------- | ------------------------------------------------------------------------- |
| Maximum teams           | **12** (humans + bots)                                                    |
| Minimum humans to start | **2**                                                                     |
| Bots                    | Fill any unclaimed slot, at the commissioner's discretion, up to 12 total |
| Visibility              | **Private** (invite only) or **Public** (open join)                       |

Bots draft and set lineups automatically for the whole season. They cannot propose
trades, place waiver claims, or vote on vetoes.

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
Week 15 is 3v6 and 4v5; Week 16 pairs the top seed against the lower surviving seed;
Week 17 is the championship. Single elimination throughout.

**Consolation bracket.** The 6 non-qualifying teams play their own bracket across
Weeks 15–17, seeded by regular-season finish. It carries a real share of the pot
(see §7) and exists to keep eliminated teams engaged.

### Tiebreakers

Applied in order for seeding:

1. Win percentage
2. **Points For**
3. Head-to-head record — _skipped unless the tied teams played an equal number of times_
4. Points Against
5. Lowest team ID

Step 5 is deterministic on purpose. No coin flips: the contract must be able to settle
without randomness when money is at stake.

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
        → ≥ 1/3 of uninvolved teams vote against?
              yes → NFTs return to their origin wallets
              no  → escrow releases, rosters swap atomically
```

Bots neither vote nor trade. The threshold is one third of _uninvolved_ teams, matching
Yahoo's — deliberately harder to trigger than ESPN's majority, because leagues that veto
trades they merely dislike are miserable.

**Trade deadline: end of Week 11.** Necessary rather than traditional — without it,
an eliminated team can hand its roster to a contender it has a side arrangement with.

---

## 7. The Pot

Optional per league. When enabled:

- **One token per league**, chosen at creation — USDC, SOL, SKR, or any SPL token.
  Every member deposits the identical amount in that token. Mixed-token pots are not
  supported: they are not a pot, they are an index fund with price risk, and there is
  no coherent definition of an equal buy-in.
- Funds lock in escrow until the championship resolves.
- A buy-in cap applies while the escrow contract is young.

### Payout

| Prize                      | Share   | Settles |
| -------------------------- | ------- | ------- |
| **Champion**               | **60%** | Week 17 |
| Runner-up                  | 15%     | Week 17 |
| Regular-season best record | 10%     | Week 14 |
| Consolation bracket winner | 10%     | Week 17 |
| 3rd place                  | 5%      | Week 17 |

Percentages are a creation-time setting, frozen with everything else. The champion must
always hold the largest single share.

The split is not decoration. Under winner-take-all, a 2–9 team in Week 11 has no
remaining reason to open the app, and abandonment becomes the rational move. Paying the
consolation bracket and the regular-season record keeps every team playing for something
into Week 17.

### Settlement

No one declares a winner. The contract holds the bracket, the scores, and the rules, and
**derives** the champion from the Week 17 result. There is no commissioner sign-off, no
vote, and no discretion.

Stats reach the chain through an oracle, since no contract can observe an NFL game.
Two independent providers must agree before a week's scores finalise; disagreement
freezes that week for review.

Finalisation is **two-tier**, because the NFL issues official stat corrections for up to
**seven days** after a game and a reclassified fumble can flip a matchup long after it
looked settled:

| Week                                                    | Provisional | Final        | Why                                                                                        |
| ------------------------------------------------------- | ----------- | ------------ | ------------------------------------------------------------------------------------------ |
| Regular season 1–13, playoffs 15–16                     | immediately | **T+48h**    | No funds move. A late correction restates standings and the bracket, which is recoverable. |
| **Week 14** (regular-season prize)                      | immediately | **T+7 days** | Money moves. Must outlast the correction window.                                           |
| **Week 17** (championship, runner-up, 3rd, consolation) | immediately | **T+7 days** | Money moves. Must outlast the correction window.                                           |

Any week that pays out waits the full seven days. Weeks that only affect standings
finalise in 48 hours so the season keeps moving. A correction arriving after a paying
week has finalised does not reopen it — the seven days exist precisely so that never
needs to happen.

---

## 8. Abandonment

A team is **abandoned** after **3 consecutive weeks** with an invalid lineup — an empty
starting slot, or a starter on bye or ruled out.

Warnings are recorded on-chain at strikes 1 and 2. No one loses a stake without visible
notice first.

On abandonment:

1. **Autolineup** takes over permanently for that team.
2. Their share of the pot is **forfeited to the champion** at settlement.

Reversible only by unanimous league consent.

**Autolineup selection** is deterministic and depends on no third party: the highest
season-to-date average scorer eligible for each slot, ties broken by ascending player ID.
It deliberately does not use projections — a projection provider that changes its model
or goes offline would otherwise alter the outcome of a rule that can never be amended.

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
