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
