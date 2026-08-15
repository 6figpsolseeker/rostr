# Tank01

Everything this project gets from its primary data provider, established by
**calling the API**, not by reading documentation. Verified 2026-08-05 against the
2025 season.

Reproduce any of it:

```bash
pnpm stats:check                      # credentials work
pnpm stats:probe                      # live response shapes
node packages/stats/dist/cli.js discover   # which endpoints exist
node packages/stats/dist/cli.js deep       # detail on the ones we use
node packages/stats/dist/cli.js verify 1,2,3   # hunt rare scoring events
```

---

## Endpoints that exist

Confirmed by calling each. `getNFLTeamStats` returned 404 and does not appear to
exist under that name.

| Endpoint               | Returns                                      | We use it for                                  |
| ---------------------- | -------------------------------------------- | ---------------------------------------------- |
| `getNFLTeams`          | 32 teams; `rosters=true` embeds full rosters | Team refs, **bye weeks**, one-call roster sync |
| `getNFLPlayerList`     | 4,295 players                                | Full player universe                           |
| `getNFLPlayerInfo`     | One player, optionally with stats            | Targeted lookups                               |
| `getNFLTeamRoster`     | `{team, roster}`                             | Per-team roster                                |
| `getNFLDepthCharts`    | 32 teams, `RB1`/`RB2`…                       | Starter inference, smarter bots                |
| **`getNFLADP`**        | `{adpDate, adpType, adpList}`                | **Draft rankings**                             |
| `getNFLProjections`    | Player + team-defense projections            | Waiver guidance, bot drafting                  |
| `getNFLGamesForWeek`   | 16 games with `gameID`, `gameTime_epoch`     | **Schedule and kickoff times**                 |
| `getNFLGamesForDate`   | Games on a date                              | Daily job scoping                              |
| `getNFLGamesForPlayer` | **A player's whole season, one call**        | Season-to-date averages, fixtures              |
| `getNFLTeamSchedule`   | `{team, schedule}`                           | Team-level schedule                            |
| `getNFLScoresOnly`     | Scores + line score, no player stats         | **Cheap game-watcher polling**                 |
| `getNFLBoxScore`       | Full player stats, DST, scoring plays        | **Weekly scoring**                             |
| `getNFLGameInfo`       | Game metadata                                | Venue, referees                                |
| `getNFLNews`           | `{link, title}`                              | Injury/news feed                               |
| `getNFLDFS`            | DraftKings, FanDuel, Yahoo salaries          | Ranking cross-check                            |
| `getNFLBettingOdds`    | Many sportsbooks                             | Not used                                       |
| `getNFLChangelog`      | Recent data corrections                      | **Stat-correction detection**                  |

---

## `gameStatus` — three endpoints, two vocabularies

Captured live on 2026-08-15, verbatim. `mapGameStatus` was written from
documentation, and this is what the endpoints actually say.

| endpoint             | `gameStatus`  | `gameStatusCode` | games seen |
| -------------------- | ------------- | ---------------- | ---------- |
| `getNFLGamesForWeek` | `"Final"`     | `"2"`            | 32         |
| `getNFLGamesForWeek` | `"Scheduled"` | `"0"`            | 16         |
| `getNFLScoresOnly`   | `"Completed"` | `"2"`            | 1 date     |
| `getNFLBoxScore`     | `"Completed"` | `"2"`            | 1 game     |

**`getNFLGamesForWeek` is the odd one out.** A finished game is `"Final"` there
and `"Completed"` on the other two — and `getNFLScoresOnly` is the endpoint the
game watcher is supposed to poll, so anything written against the schedule
endpoint's vocabulary would read every finished game as unstarted. `mapGameStatus`
survives it only because matching is by prefix, which was a hedge rather than a
plan.

**`gameStatusCode` is the stable half.** `"2"` means finished on all three;
`"0"` means not started. It is the better discriminator and it is _not_ what the
code keys on today — deliberately, because only two of its values have been
observed and guessing the rest is how the field names in this document were wrong
four times. Worth switching to once the in-progress and postponed codes are seen.

**Not yet observed, and honestly outstanding:** `IN_PROGRESS`, `POSTPONED` and
`CANCELLED`. None exists out of season, so these need a live Sunday. Until then
`mapGameStatus`'s handling of them is documentation, not evidence — and its
fallback warns loudly and answers `SCHEDULED`, which for a _finished_ game means
finalisation falls to `RULES.md` §10's postponement path.

Reproduce with `pnpm stats:probe`, or:

```
curl --url 'https://tank01-nfl-live-in-game-real-time-statistics-nfl.p.rapidapi.com/getNFLGamesForWeek?week=1&seasonType=reg&season=2025' \
     --header 'x-rapidapi-key: <key>'
```

---

## The shape of a box score

`getNFLBoxScore` returns one object with these parts:

```
playerStats[playerID]   per-player, grouped into stat categories
DST.home / DST.away     team defense — the only source of ptsAllowed
scoringPlays[]          play-by-play scoring summary
teamStats.home/away     team totals
lineScore               quarter-by-quarter
homePts / awayPts       final score
```

### Stat categories

A category is **absent** when a player has none of it. There is no zero.

| Category     | Fields                                                                                                                                          |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `Passing`    | `passYds passTD int passAttempts passCompletions passAvg qbr rtg sacked`                                                                        |
| `Rushing`    | `rushYds rushTD carries rushAvg longRush`                                                                                                       |
| `Receiving`  | `recYds recTD receptions targets recAvg longRec`                                                                                                |
| `Kicking`    | `fgMade fgAttempts fgMissed fgLong xpMade xpAttempts xpMissed fgPct kickingPts` + kick-return fields                                            |
| `Defense`    | `totalTackles soloTackles sacks defensiveInterceptions passDeflections defTD forcedFumbles **fumbles fumblesLost** fumblesRecovered qbHits tfl` |
| `Punting`    | `punts puntYds puntAvg puntLong puntsin20 puntTouchBacks`                                                                                       |
| `snapCounts` | `offSnap offSnapPct defSnap defSnapPct stSnap stSnapPct`                                                                                        |

> **Fumbles live under `Defense`, even for offensive players.** Confirmed:
> Miles Sanders in `20250904_DAL@PHI` has `Defense.fumblesLost = "1"` alongside
> his `Rushing` and `Receiving` lines. There is no `Rushing.fumblesLost`.

### Everything is a string

`"188"`, not `188`. Some fields are ratios — `sacked: "0-0"`,
`penalties: "4-42"`, `possession: "25:08"`. `parseStatValue()` returns `null`
for those rather than `0`, so a bad mapping surfaces instead of silently
scoring zero.

---

## Scoring plays: the only source for three of our rules

There are exactly **three** `scoreType` values across 96 games spanning the whole
2025 season: `TD`, `FG`, `SF`. See [Recheck](#recheck).

Extra points, two-point conversions, and blocked kicks are **not score types**.
They appear in the trailing parenthetical of a touchdown's `score` text.

Every observed form:

| Text                                                                   | Meaning                 |
| ---------------------------------------------------------------------- | ----------------------- |
| `(Brandon Aubrey Kick)`                                                | Extra point made        |
| `(Harrison Butker PAT Failed)`                                         | Extra point missed      |
| `(Joshua Karty PAT blocked)`                                           | Extra point **blocked** |
| `(Rhamondre Stevenson Run for Two-Point Conversion)`                   | Two-point **good**      |
| `(Tua Tagovailoa Pass to Julian Hill for Two-Point Conversion)`        | Two-point **good**      |
| `(Two-Point Pass Conversion Failed)`                                   | Two-point **failed**    |
| `Blocked Kick Recovered by Jordan Davis (PHI) … 61 Yd Touchown Return` | Blocked kick returned   |

Three consequences:

**Field goal distances are prose.** `Kicking` gives `fgMade` and `fgLong` —
counts, never per-kick distances. Our rules pay 3/4/5 by distance, so distances
are parsed out of `"Brandon Aubrey 41 Yd Field Goal"`. The parsed count is
cross-checked against `fgMade`; a mismatch is raised, not absorbed.

**"Failed" is the only discriminator for two-point conversions.** A successful
one names the players; a failure often does not. Matching on `Two-Point` alone
would award two points for a conversion that did not happen.

**Tank01's text contains typos.** `"61 Yd Touchown Return"` is verbatim. Match
stable tokens, never whole phrases.

---

## ADP — the draft ranking source

```
getNFLADP?adpType=PPR
{ adpDate: "20260805", adpType: "PPR", adpList: [...] }
```

Each entry: `{ overallADP, posADP, playerID, longName }`

```json
{ "posADP": "RB1", "overallADP": "3.2", "playerID": "4429795", "longName": "Jahmyr Gibbs" }
{ "posADP": "WR3", "overallADP": "4.6", "playerID": "4430878", "longName": "Jaxon Smith-Njigba" }
```

This is exactly what `DraftablePlayer.rank` needs, and it is dated **today** —
current, not stale. `posADP` additionally gives positional rank, which is what a
smarter bot would use for positional scarcity.

**One call fills the entire draft board.**

---

## Projections

```
getNFLProjections?week=N&archiveSeason=YYYY   one week
getNFLProjections?archiveSeason=YYYY          THE WHOLE SEASON
```

### Season totals come from omitting `week`

**Verified live 2026-08-06.** With no `week` parameter the response comes back
with `"week": "season"` and season-scale magnitudes:

```
Ja'Marr Chase   recYds 1457   receptions 121   recTD 11.2
Jahmyr Gibbs    rushYds 1231  receptions 63.9
Aaron Rodgers   passYds 3245  passTD 24.9
```

Compare week 1 alone, where Rodgers reads `passYds 201`. One call covers **622
players and all 32 team defenses** — the whole draft board's projections.

`isSeasonAggregate()` checks that `"season"` string before trusting a response,
because a silently weekly payload would produce a draft board where every player
looked like a backup.

### Fields, unioned across the whole season response

```
top:  Kicking, Passing, Receiving, Rushing, fantasyPointsDefault,
      fumblesLost, longName, playerID, pos, team, teamID, twoPointConversion
sub:  Kicking.fgMade, Kicking.fgMissed, Kicking.xpMade, Kicking.xpMissed,
      Passing.int, Passing.passAttempts, Passing.passCompletions,
      Passing.passTD, Passing.passYds, Receiving.recTD, Receiving.recYds,
      Receiving.receptions, Receiving.targets, Rushing.carries,
      Rushing.rushTD, Rushing.rushYds
```

Positions present: `QB 92, RB 142, WR 212, TE 123, PK 47, FB 6`. **`PK` and `FB`
again** — the same spelling that silently dropped every kicker from the draft
board once already.

### Kickers are projected, but only as a total

`Kicking.fgMade` is a single number — `27.1` — with **no distance breakdown**,
and our scoring pays 3, 4, or 5 by distance. Every projected field goal is
therefore counted in the 3-point tier, making kicker projections a **floor**
(Brandon Aubrey scores 133.0 where a real projection is nearer 150).

Acceptable because the board groups by position, so kickers are only ever
compared with each other, and the ordering is unaffected. Inventing a distance
distribution to look precise would be worse than being visibly conservative.

### Team defense

```json
{
  "returnTD": "0.3",
  "defTD": "1.2",
  "safeties": "0.1",
  "fumbleRecoveries": "6.3",
  "ptsAgainst": "230",
  "teamAbv": "ARI",
  "interceptions": "10.6",
  "sacks": "33.2",
  "blockKick": "1.1",
  "fantasyPointsDefault": "73.3"
}
```

`defTD` and `returnTD` are **summed before rounding** into our `def_td`:
`RULES.md` §1 pays 6 for a "defensive **or special teams** touchdown". Rounding
each separately turns 1.2 + 0.3 into one touchdown instead of two.

Not to be confused with `ret_td`, which is the individual returner's six points
and belongs to a different roster spot.

### `fantasyPointsDefault` is ignored, deliberately

It is Tank01's arithmetic. Every league scores raw stats against its own frozen
rules — ours pays 4 for a passing touchdown — so a provider's number on the draft
board would disagree with the number that decides matchups.

Scored with our own PPR rules, the top of each position reads:

```
QB   Josh Allen 334.4    RB   Jahmyr Gibbs 342.8    WR  Ja'Marr Chase 340.6
TE   Brock Bowers 231.5  K    Brandon Aubrey 133.0  DEF Denver 105.0
```

### The old weekly notes

```
getNFLProjections?week=N&archiveSeason=YYYY
{ playerProjections, teamDefenseProjections, week, season }
```

524 players. Note the shape **differs from box scores**:

- `fumblesLost` sits at the top level, not under `Defense`
- `twoPointConversion` exists as a field — but only in projections. Actuals still
  require parsing scoring plays.
- `fantasyPointsDefault` is Tank01's own scoring, in several formats. Ignore it;
  we score from raw stats against each league's frozen rules.

Team defense projections carry `blockKick`, `ptsAgainst`, `sacks`,
`interceptions`, `fumbleRecoveries`, `safeties`, `defTD`, `returnTD`.

---

## Cost-efficient call patterns

Data cost is O(games), not O(users) — one fetch is scored against every league.
These patterns keep the multiplier low:

| Need                    | Cheap way                                                         | Cost           |
| ----------------------- | ----------------------------------------------------------------- | -------------- |
| All 32 rosters          | `getNFLTeams?rosters=true`                                        | **1 call**     |
| Bye weeks               | Same call — `byeWeeks` is a per-season map                        | **free**       |
| Full draft board        | `getNFLADP`                                                       | **1 call**     |
| Is a game final?        | `getNFLScoresOnly?gameDate` — all games that day, no player stats | **1 call/day** |
| Weekly scoring          | `getNFLBoxScore` per game                                         | 16/week        |
| A player's whole season | `getNFLGamesForPlayer`                                            | **1 call**     |
| Stat corrections        | `getNFLChangelog`                                                 | 1/day          |

The game watcher should poll `getNFLScoresOnly`, not box scores: one call covers
every game on a date, and the full box score is only fetched once a game reads
`Final`.

`byeWeeks` returning `{"2025":["8"],"2026":["14"]}` means bye weeks come free
with the roster sync — no separate source needed for autolineup validity.

---

## Recheck

The scoring-play findings were re-verified on a **different** part of the season
— weeks 12, 15, and 18, another 48 games — after being established on weeks 1–3.

**96 games total, spanning the whole season.** No new `scoreType` values and no
new parenthetical forms appeared. The claims above hold.

One thing the recheck did surface:

```
Ray Davis 97 Yd Kickoff Return (Matt Prater Kick)
```

Return touchdowns were missing from our scoring table. **Now added as `ret_td` at
6 points**, matching ESPN and Sleeper, which both treat a player's return
touchdown as a category separate from the defensive unit's.

Scanning weeks 4, 8, 14 and 17 for every return touchdown produced the full
vocabulary — and a trap:

| Text                                             | Scores as                  |
| ------------------------------------------------ | -------------------------- |
| `Rashid Shaheed 100 Yd Kickoff Return`           | `ret_td`                   |
| `Marcus Jones 87 Yd Punt Return`                 | `ret_td`                   |
| `Sydney Brown 35 yd. return of blocked punt`     | `ret_td`                   |
| `Jared Verse 76 Yd Return of Blocked Field Goal` | `ret_td`                   |
| `Christian Benford 63 Yd Interception Return`    | **`def_td`, not `ret_td`** |
| `T.J. Edwards 34 Yd Interception Return`         | **`def_td`, not `ret_td`** |

Interception and fumble returns are defensive touchdowns we already score.
Counting them as return touchdowns as well would pay one play under two rules —
precisely the misconfiguration Sleeper's own documentation warns about.
`isSpecialTeamsReturnTouchdown()` excludes them, and a test asserts every real
return play lands in exactly one bucket.

Note `"35 yd. return of blocked punt (J.Elliott kick)"`: lowercase, abbreviated
name, full stop after "yd". Tank01's play text comes from more than one source
and its formatting is not uniform — another reason to match tokens rather than
whole phrases.

---

## Known gaps

**None that affect the stats we currently score.** Every stat in the PPR table is
obtainable:

- ✅ Passing, rushing, receiving, receptions — direct fields
- ✅ Fumbles lost — `Defense.fumblesLost`
- ✅ Extra points — `Kicking.xpMade`
- ✅ Field goals by distance — parsed from scoring plays
- ✅ Two-point conversions — parsed from scoring plays
- ✅ Blocked kicks — parsed from scoring plays
- ✅ Defensive points allowed, sacks, interceptions, fumble recoveries,
  safeties, defensive touchdowns — the `DST` block

Outstanding questions, none blocking:

- **Two-point attribution.** `scoringPlays[].playerIDs` exists but which ID maps
  to passer versus receiver has not been confirmed. Our rules award 2 points for
  pass, rush, _and_ reception, so attribution matters.
- **`getNFLChangelog` returned empty** for a 3-day window. Its behaviour during
  an active season, and whether it is a usable stat-correction signal, is
  untested.
- **Rate limits.** Basic is 1,000 calls/month. A live season is ~700 by our
  estimate, so **Pro ($10/mo) before Week 1** is not optional.
