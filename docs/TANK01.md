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

**Return touchdowns are not in our scoring table.** `RULES.md` §1 pays for
passing, rushing, receiving, and defensive/special-teams touchdowns, but there is
no line for a _player_ returning a kick for six. ESPN and Sleeper both award 6
points to the returner by default, so this is a gap in our rules rather than in
the data.

The data is there: `Kicking.kickReturnTD` is a real field, and team defense
projections carry `returnTD`. Punt-return touchdowns are less clear — the
`Punting` category covers punters, not returners, so a source for those is still
unconfirmed.

This is an owner decision, since it changes the frozen scoring table. Tracked in
[`SETUP-REQUIRED.md`](SETUP-REQUIRED.md).

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
