# Data Model

Football ships first, but nothing in the schema knows what football is. Sport-specific
knowledge lives in **data rows**, never in table structure, column names, or code
branches. Adding basketball later should be a migration that inserts rows, not one that
alters tables.

The rule that enforces this: **if a column name contains a football word, it is wrong.**
No `passing_yards` column, no `is_quarterback` flag, no `POSITION_QB` enum.

---

## The core abstraction

Scoring is a fold over stat lines:

```
team_week_score = Σ  apply(rule[stat_key], stat_value)
```

A sport is nothing more than a registered set of **stat keys**, a set of **positions**,
and the **slots** a lineup is made of. The scoring engine never learns a sport's name.

### Two kinds of rule

Most scoring is linear — a multiplier per unit. Some is not, and the schema has to
admit that up front or it gets bolted on badly later.

| Kind     | Shape                             | Football examples                                               |
| -------- | --------------------------------- | --------------------------------------------------------------- |
| `LINEAR` | `points = value × multiplier`     | 0.04/passing yard, 1.0/reception, −2/interception, 4/passing TD |
| `TIERED` | `points = lookup(value in range)` | DEF points allowed (0 → 10, 1–6 → 7, … 35+ → −4)                |

Field goals by distance are deliberately **not** tiered. Modelling them as a tier would
require the engine to see individual kick events. Instead the provider adapter buckets
them into three linear stat keys — `fg_made_0_39`, `fg_made_40_49`, `fg_made_50_plus` —
each with a flat multiplier. The complexity stays in the adapter, where it belongs, and
the engine keeps a single uniform shape.

---

## Tables

### Sport registry

```
sports            id, key ('nfl'), display_name, season_weeks, active
stat_keys         id, sport_id, key ('rec_yds'), display_name, kind (LINEAR|TIERED)
positions         id, sport_id, key ('WR'), display_name, sort_order
slot_types        id, sport_id, key ('FLEX'), eligible_position_ids[]
```

`slot_types.eligible_position_ids` is what makes FLEX work without the engine knowing
that RB, WR, and TE are interchangeable in football. A basketball G/F slot is the same
mechanism with different rows.

### Players and stats

```
players           id, sport_id, external_ref, full_name, primary_position_id,
                  eligible_position_ids[], team_ref, status, active
player_seasons    id, player_id, season, team_ref, bye_week
stat_lines        id, player_id, season, week, stat_key_id, value,
                  source, revision
```

**`players.active` is the only liveness flag, and `players.status` is dead.**
`active` means exactly one thing — the provider currently lists him on an NFL
club. The daily sync re-asserts it in both directions for every player the
provider still lists; a player it stops listing altogether is never updated
again and keeps whatever value he last had. It is a
**sort key, never a filter** — and since 2026-09-22, not always a sort key
either. A player his club has cut stays draftable and addable, sorts to the
bottom of the **free-agent list**, and sorts on the **draft board** wherever his
ADP puts him (owner's rulings: 2026-09-16, issue #276; amended 2026-09-22). The
board dropped the demotion because it was measured to be defending against
nobody — see "What is actually in `player_rankings_current`" below. The market
keeps it because that query has no other ordering at all and roughly a third of
the pool is inactive, which is a problem about admission rather than about
price. `autoPick` keeps it too, as an explicit key of its own, because its
endgame scans one position at a time. The three disagree on purpose. The one
reader that keeps the opposite polarity is the notification telling the manager
_holding_ him, which asks a different question.

### What is actually in `player_rankings_current` — measured, not reasoned

Established by **querying production**, not by reading the schema. Verified
2026-09-22 against the 2026 NFL season.

Two product rulings were taken on the schema alone and the second one was wrong,
in the same way as the first: `player_rankings` is never pruned, therefore a cut
player keeps a good ADP, therefore the draft board must demote him. The first
step is true. The second does not follow, because the provider does not stop
ranking a released player — it keeps ranking him, worse every week. **Run these
before arguing about what a cut player's ADP does.**

Board size, and how much of it carries an ADP at all:

```sql
SELECT count(*)                                        AS board_rows,
       count(*) FILTER (WHERE r.player_id IS NOT NULL) AS with_adp,
       count(*) FILTER (WHERE r.player_id IS NULL)     AS without_adp
  FROM players p
  LEFT JOIN player_rankings_current r
    ON r.player_id = p.id AND r.season = 2026
 WHERE p.sport_id = (SELECT id FROM sports WHERE key = 'nfl');
-- 1589 | 567 | 1022          (2026-09-22)
```

**Two rows in three carry no ADP.** That is the number the draft room's `ADP`
column has to survive, and until 2026-09-22 it did not — it printed `rank`, a
dense board index every unranked player also has, which invented a crowd's
opinion for 1,022 players. It now prints `adpMilli` or an em dash.

How many ranking combinations exist. This is the query that unblocked #307 — the
loader's `COALESCE($3, r.source)` filtered nothing when omitted, and every caller
omitted it, so a player with two sources came back twice. It was left unfixed
because a default that failed to match what `syncRankings` writes would blank the
whole board, and nobody had checked what was actually stored:

```sql
SELECT season, source, ranking_type, count(*) AS rows
  FROM player_rankings GROUP BY 1, 2, 3 ORDER BY rows DESC;
-- 2026 | tank01 | PPR | 17883     -- one row. One combination exists.

SELECT count(*) FROM (
  SELECT player_id FROM player_rankings_current WHERE season = 2026
   GROUP BY player_id HAVING count(*) > 1) duplicated;
-- 0
```

One combination, zero doubled players — so the defect was **measured** latent
rather than assumed latent, and `loadDraftBoard` now filters on
`PRIMARY_RANKING_BOARD` instead of defaulting to "all". 17,883 rows across 567
players is about 31 dated snapshots each: the daily sync is running and ADP is
moving.

What made the hard default safe was closing the way the two sides could
disagree. `syncRankings` used to store the provider's echoed `adpType` in
`ranking_type` — a key column holding a string the vendor controlled — and now
stores the format we asked for, reporting a mismatch through `cron_runs`. The
only remaining way to blank the board is `Tank01Provider.name` drifting from the
constant, which is one string equality and has a test that imports the real
adapter. It cannot be a compile-time guarantee: `@rostr/stats` depends only on
`@rostr/core`, so the adapter cannot import from `@rostr/db`.

Which rows are **frozen** — a "current" row older than the newest the feed has
written. `syncRankings` writes only for players in that day's feed, so a player
the provider drops is never superseded again:

```sql
WITH newest AS (
  SELECT max(as_of) AS feed FROM player_rankings_current WHERE season = 2026)
SELECT p.full_name, p.active, r.overall_milli / 1000.0 AS adp, r.as_of
  FROM player_rankings_current r
  JOIN players p ON p.id = r.player_id, newest
 WHERE r.season = 2026 AND r.as_of < newest.feed
 ORDER BY r.overall_milli;
-- 42 rows. Best is Jayden Higgins at 121.6 — and he is still on a roster, so
-- no club guard would ever have moved him. Every other frozen row is 249+.
-- Nine of them are also cut: Moody 249.0, Chubb 330.6, Hardman 337.5 among
-- them. "Frozen and cut" is not hypothetical. It is nine players, and every
-- one of them is harmless.
```

And the query that decides the question — the best ADP anyone with no NFL club
holds:

```sql
SELECT p.full_name, r.overall_milli / 1000.0 AS adp, r.as_of
  FROM player_rankings_current r
  JOIN players p ON p.id = r.player_id
 WHERE r.season = 2026 AND NOT p.active
 ORDER BY r.overall_milli LIMIT 10;
-- Jake Moody   249.0
-- Tyreek Hill  297.4   as_of 2026-09-21   <- current, not frozen
-- Joe Mixon    320.6                      <- current, not frozen
```

**A released player is re-priced, not frozen.** A 12-team, 15-round draft is 180
picks, so the best club-less player in the pool sits 69 picks past the last one
anybody makes.

What survives, and is the only thing that was ever true here: a player the
provider stops listing **altogether** is never superseded. No such player is
anywhere near the top of the 2026 board. That is a fact to monitor, not a
premise to design from — **re-run the last query rather than re-deriving it.**

`overall_milli` is `Math.round(adp * 1000)` (`packages/stats/src/tank01/adapter.ts`),
so 297.4 is stored 297400. Divide by 1000 to render.

`status` is written by nothing and read by nothing. It was added in `0003` with
`NOT NULL DEFAULT 'ACTIVE'`, is absent from `syncPlayers`' insert list, and
therefore holds that one string on every row in the table. It is left in place
rather than dropped by migration — migrations here are forward-only and
permanent, and the column costs a short string per row — but **do not reach for
it**. Somebody looking for "is this player available" will find a column called
`status` before they find `active`, and that is the confusion #276 existed to
end.

`external_ref` is the provider's ID. `stat_lines.revision` exists because the NFL
revises box scores after games — a reclassified fumble can flip a matchup days later.
Rows are versioned rather than overwritten, so a settled week can always be audited
against exactly the data it settled on.

Multi-position eligibility is an array, not a second table. A player is a WR who also
qualifies for FLEX; that is a property of the player, not a relationship.

### Leagues

```
leagues           id, sport_id, season, name, visibility (PRIVATE|PUBLIC),
                  commissioner_id, rules_hash, rules_uri, state, created_at
league_rules      id, league_id, rule_json, hash          -- immutable, one row, ever
scoring_rules     id, league_id, stat_key_id, kind, multiplier, tiers_json
roster_slots      id, league_id, slot_type_id, count, ordinal
```

`league_rules` has no `updated_at` and takes no UPDATE. `rules_hash` is what lives
on-chain; `rules_uri` points at the full document on IPFS or Arweave. A join transaction
references the hash, so consent is cryptographic rather than implied by a checkbox.

`scoring_rules` is a **copy** of the league's scoring at creation, not a foreign key to a
shared template. If a default table were ever edited, every league referencing it would
silently change — which is precisely the thing immutability is meant to prevent.

### Teams and rosters

```
teams             id, league_id, owner_id (nullable), is_bot, name,
                  draft_position, waiver_priority, ~~strikes, abandoned_at~~ (dropped by migration `0015` — abandonment was removed in schema 4)
roster_entries    id, team_id, league_id, player_id, acquired_via, acquired_at,
                  released_at
lineups           id, team_id, week, slot_type_id, player_id, locked_at
```

`owner_id` is nullable and `is_bot` is a flag on the same table — a bot is a team without
an owner, not a separate entity. Keeps every join, standing, and matchup query uniform.

`roster_entries` is append-only with `released_at`, so full roster history is
reconstructible for any week. `lineups` records what was actually started, never derived
after the fact — a settled week must be provable.

`roster_entries.league_id` is the team's own league, **derived by trigger and never
supplied by a writer**. It is denormalised for one reason: a partial unique index cannot
join, so the only way to enforce "one active owner per league" — the rule `0005` claimed
and did not enforce — is to put the league on the row. The composite foreign key
`(team_id, league_id) -> teams (id, league_id)` is what stops the copy drifting from the
original. See migration `0022`.

### Play

```
matchups          id, league_id, week, home_team_id, away_team_id,
                  home_points, away_points, phase (REGULAR|PLAYOFF|CONSOLATION),
                  finalized_at
transactions      id, league_id, team_id, type, player_ids[], week, created_at
trades            id, league_id, proposer_team_id, receiver_team_id, assets_json,
                  state, escrow_pda, veto_deadline, executed_at
trade_votes       id, trade_id, team_id, created_at
```

`matchups.phase` covers regular season, playoff bracket, and consolation bracket with one
table. All three are two teams and a week; nothing about them differs structurally.

### Identity

```
users             id, email, email_verified_at, display_name, created_at
wallets           id, user_id, address, chain, verified_at, is_primary
```

Email and wallet both required. IP addresses are logged to a separate audit table as a
**signal for review**, never as a join gate — households, dorms, and offices share
addresses, and those are exactly the people who play in leagues together.

---

## On-chain vs off-chain

The chain holds what must be trustless. Postgres holds what must be queryable.

| On-chain                      | Off-chain                            |
| ----------------------------- | ------------------------------------ |
| `rules_hash` and join consent | Full rule document (hash anchors it) |
| Pot escrow, deposits, payouts | Player database, stat lines          |
| Roster NFTs (Token-2022)      | Standings, matchups, schedule        |
| Trade escrow + veto tally     | Draft queues, UI state               |
| Abandonment strikes           | Notification state                   |
| Finalised weekly scores       | Provisional scores in the 48h window |

Anything the chain settles on must be reconstructible from off-chain data, and anything
off-chain that contradicts the chain is wrong by definition.

---

## Adding a second sport

The intended path, start to finish:

1. Insert a row in `sports`.
2. Insert that sport's `stat_keys`, `positions`, and `slot_types`.
3. Write one provider adapter that emits `stat_lines` against those keys.
4. Ship a default scoring template for league creation.

No schema migration. No changes to the scoring engine, the draft, waivers, trades, the
escrow contract, or the bracket. If step 4 turns out to require a code change, the
abstraction has leaked and the fix belongs in the schema, not in a conditional.
