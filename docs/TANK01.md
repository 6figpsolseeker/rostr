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

| Endpoint               | Returns                                       | We use it for                                    |
| ---------------------- | --------------------------------------------- | ------------------------------------------------ |
| `getNFLTeams`          | 32 teams; `rosters=true` embeds full rosters  | Team refs, **bye weeks**, one-call roster sync   |
| `getNFLPlayerList`     | 4,295 players                                 | Full player universe                             |
| `getNFLPlayerInfo`     | One player, optionally with stats             | Targeted lookups                                 |
| `getNFLTeamRoster`     | `{team, roster}`                              | Per-team roster                                  |
| `getNFLDepthCharts`    | 32 teams, `RB1`/`RB2`…                        | Starter inference, smarter bots                  |
| **`getNFLADP`**        | `{adpDate, adpType, adpList}`                 | **Draft rankings**                               |
| `getNFLProjections`    | Player + team-defense projections             | Waiver guidance, bot drafting                    |
| `getNFLGamesForWeek`   | 16 games; `gameTime_epoch` **empty when TBD** | **Schedule and kickoff times** — see below       |
| `getNFLGamesForDate`   | Games on a date                               | Daily job scoping                                |
| `getNFLGamesForPlayer` | **A player's whole season, one call**         | Season-to-date averages, fixtures                |
| `getNFLTeamSchedule`   | `{team, schedule}`                            | Team-level schedule                              |
| `getNFLScoresOnly`     | Scores + line score, no player stats          | **Cheap game-watcher polling**                   |
| `getNFLBoxScore`       | Full player stats, DST, scoring plays         | **Weekly scoring**                               |
| `getNFLGameInfo`       | Game metadata                                 | Venue, referees                                  |
| `getNFLNews`           | `{link, title}`                               | Injury/news feed                                 |
| `getNFLDFS`            | DraftKings, FanDuel, Yahoo salaries           | Ranking cross-check                              |
| `getNFLBettingOdds`    | Many sportsbooks                              | Not used                                         |
| `getNFLChangelog`      | Recent data corrections                       | **Stat-correction detection**                    |
| `getNFLInactiveList`   | Whole season, per game, per team `players[]`  | **Gameday inactives** — see docs/LIVE-SCORING.md |

---

## A fixture with no kickoff time — verbatim, 2026-08-17

The NFL fixes late-December kickoff **hours** last, holding them back for flex scheduling.
Tank01 still returns **all 16 fixtures** for those weeks. The untimed ones carry:

```
gameDate:        "20261227"      ← the day IS known
gameTime:        "TBD"
gameTime_epoch:  ""              ← empty string. Not "0", not absent, not null.
```

So `Number.parseFloat(gameTime_epoch)` is `NaN` and `Number(gameTime_epoch)` is `0` — any
code treating a falsy epoch as "there is no fixture" drops a real game. **It did:** eight
fixtures across weeks 16 and 17 of 2026, the playoff and championship weeks, absent from
the deployed database for two days before anyone counted.

`syncGames` now stores them with `kickoff_tbd` set and a conservative kickoff borrowed
from a dated sibling on the same date; `gameAvailability` in `@rostr/core` turns that into
`TIME_TBD`. Where **no** game on that date is dated there is nothing safe to borrow and
the fixture is still skipped, which is `UNSCHEDULED`.

**Week 18 is entirely undated** as of 2026-08-17 — all 16 fixtures on `20270110`, every
one `"TBD"` — so none of it is stored. That is correct and harmless here: week 18 falls
after the fantasy championship in week 17.

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

`TD`, `FG` and `SF` are the three that carry meaning for us, and they were the
only three seen across the 96 games sampled in [Recheck](#recheck).

> **Corrected 2026-08-17.** This section said "there are exactly **three**
> `scoreType` values" and that was a claim about a sample, not about the feed. A
> sweep of the **full** 2025 season also found `2PTC` and a `null`, and a sweep
> of **2024** found `BP`. Do not write a `switch` over this field.

### `BP` — and why nothing decides a touchdown by reading this field any more

The fifth value, verbatim from `20241208_BUF@LAR`, captured as
`__fixtures__/box-score-blocked-punt-scoretype.json`:

```
BP | LAR | Hunter Long 22 Yd Return of Blocked Punt (Joshua Karty Kick)
```

That is a touchdown. Both places that pay six points for a special-teams score
asked `play.scoreType === "TD"`, so it reached neither the returner nor the unit
— **12 points on one play, in two roster spots.** Nothing else made it up:
`DST.defTD` reads `"0"` for the Rams in that game and
`defensiveOrSpecialTeamsTds` reads `"0"` too, so even the cross-check agreed with
the silence. `teamStats.blockedPunt` reads `"1"`, so the _block_ was counted; it
is the touchdown that is not.

**The adapter now asks the question negatively.** `isTouchdownScoringPlay`
refuses `FG`, `SF` and `2PTC` — the three values observed carrying a
non-touchdown event — and treats everything else, including an unfamiliar value
and an absent one, as eligible. The text pattern is what names the event. An
allow-list of `TD` and `BP` would fix the one play we found and leave the next
unknown value exactly as expensive; this list has now been wrong twice.

Two things follow, both of them in code:

- **A `BP` play is in neither of the provider's touchdown counters**, so the
  `defensiveOrSpecialTeamsTds` cross-check excludes it, or it would fire on a
  game we have just started scoring correctly. This rests on the single `BP` play
  in two seasons and says so in `isUncountedSpecialTeamsScoreType`.
- **An unrecognised `scoreType` is warned about**, once per game per value. `BP`
  sat in the feed for two seasons and what found it was a human sweeping 544
  games. Inert is the right behaviour; silent is not.

> A second 2024 play was expected to be `BP` and is not. `20241229_CAR@TB` —
> `TD | TB | J.J. Russell 23 Yd Return of Blocked Punt (Chase McLaughlin Kick)` —
> is an ordinary `TD` and cost six points for an unrelated reason. See
> [Who scored](#playerids-does-not-name-the-scorer) below.

### `playerIDs` does not name the scorer

Verbatim, `20241229_CAR@TB`, captured as
`__fixtures__/box-score-returner-not-in-playerids.json`:

```
TD | TB | J.J. Russell 23 Yd Return of Blocked Punt (Chase McLaughlin Kick)
   | playerIDs: ["3150744"]
```

`3150744` is **Chase McLaughlin, the kicker**. The man the sentence names is not
in the array at all, and Tank01's entire record for him in this game is a
`snapCounts` block — no `scoringPlays`, no `Defense`. So the per-player loop had
two independent reasons to miss him, and a fix to either alone would have changed
nothing.

This is the same shape as the two-point conversion in `20250907_MIA@IND`
(issue #155), one category over. Return touchdowns are now resolved by a
game-level pass over the **main clause**, matched against every named player in
the response, with `playerIDs` demoted to a tiebreak when more than one player
answers to the same spelling. A return has exactly one scorer, so two distinct
matches is a fact about our name matching and credits nobody, loudly.

Extra points, two-point conversions, and blocked kicks are **not score types**.
They appear in the trailing parenthetical of a touchdown's `score` text.

Every observed form:

| Text                                                                   | Meaning                  |
| ---------------------------------------------------------------------- | ------------------------ |
| `(Brandon Aubrey Kick)`                                                | Extra point made         |
| `(Harrison Butker PAT Failed)`                                         | Extra point missed       |
| `(Joshua Karty PAT blocked)`                                           | Extra point **blocked**  |
| `(Rhamondre Stevenson Run for Two-Point Conversion)`                   | Two-point **good**       |
| `(Tua Tagovailoa Pass to Julian Hill for Two-Point Conversion)`        | Two-point **good**       |
| `(Two-Point Pass Conversion Failed)`                                   | Two-point **failed**     |
| `Blocked Kick Recovered by Jordan Davis (PHI) … 61 Yd Touchown Return` | Blocked kick returned    |
| `Marshawn Kneeland Blocked Punt Recovery in End Zone`                  | Blocked punt, recovered  |
| `Defensive Holding in Endzone for Safety`                              | Safety, `scoreType` `SF` |

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

## `teamStats` — the second team-level block

Established 2026-08-17, after a full-season comparison against Sleeper turned up
four defects in the D/ST and player translation. **This block was read nowhere
until then**, and three of the four fixes come out of it. Same `home` / `away`
shape as `DST`, same string-typed values (`blockedFG: "1"`, not `1`).

| Field                                | What it is                                            |
| ------------------------------------ | ----------------------------------------------------- |
| `blockedFG`                          | Field goals **this team blocked**                     |
| `blockedPunt`                        | Punts this team blocked                               |
| `blockedXP`                          | Extra points this team blocked                        |
| `defensiveOrSpecialTeamsTds`         | Def + ST touchdowns — **double-counted, see below**   |
| `safeties`                           | Safeties this team scored                             |
| `defensiveTwoPointConversionReturns` | Failed conversions this defence took back — **2 pts** |
| `fumblesLost`                        | Fumbles **this team lost**, not recoveries it made    |

The full key list, from a captured response, so a field can be looked for before
it is guessed at:

```
totalYards rushingAttempts rushingYards fumblesLost penalties totalPlays
possession safeties passCompletionsAndAttempts passingFirstDowns
interceptionsThrown sacksAndYardsLost thirdDownEfficiency blockedPunt
yardsPerPlay redZoneScoredAndAttempted teamID defensiveInterceptions
defensiveOrSpecialTeamsTds totalDrives rushingFirstDowns blockedFG rushTD
twoPointConversions firstDowns passTD team blockedXP teamAbv
firstDownsFromPenalties fourthDownEfficiency defensiveTwoPointConversionReturns
passingYards yardsPerRush snapCounts turnovers yardsPerPass
```

**There is no fumble-recovery counter here**, which is the point of listing it
in full — see [fumble recoveries](#dstfumblesrecovered-is-the-opponents-fumbles-lost)
below.

### Defensive two-point conversion returns

A defence that takes a failed conversion attempt back the other way scores **2**
under ESPN's table. We had no stat key at all until 2026-08-17, so it scored
nothing: three occurrences across 2024 and 2025 — Dallas in 2025 week 4
(`"Markquese Bell Defensive PAT Conversion"`), Miami in 2025 week 13,
Philadelphia in 2024 week 4.

`teamStats.defensiveTwoPointConversionReturns` carries the count, and it is read
as a number rather than parsed out of the play text: the wording varies, the
event is rare enough that a pattern would go years without being exercised, and
unlike a field goal's distance there is nothing here that only the prose knows.

Added as `def_2pt_ret`, schemaVersion 6 → 7. Stat keys are append-only.

### Blocked kicks are credited to the blocking team

The fact that had to be nailed down before these could be used at all, because
getting it backwards is a four-point swing between two rosters.

**Proven on `20250907_ARI@NO` (2025 week 1).** Arizona's kicker had a field goal
blocked. **New Orleans**' `teamStats.blockedFG` reads `"1"`; Arizona's reads
`"0"`. Captured as `packages/stats/src/tank01/__fixtures__/box-score-blocked-fg.json`.

That game is also why this matters: **no scoring play in it mentions a block at
all**, so the play-text path — the only source before this — scored New Orleans
zero. **27 of the 44 blocked kicks in the 2025 season never led to a score**, 54
points invisible.

**The counters include a block that scored.** Proven on `20251103_ARI@DAL`, where
Marshawn Kneeland recovered a blocked punt in the end zone for a touchdown and
Dallas reads `blockedPunt: "1"`. So the numeric counters and the text path are
combined by taking the **larger**, never by adding — adding pays twice.

### `defensiveOrSpecialTeamsTds` double-counts, and is a check rather than a source

`20250928_CAR@NE` has **exactly one** defensive or special-teams touchdown in it,
Marcus Jones's 87-yard punt return. New England's `defensiveOrSpecialTeamsTds`
reads **`"2"`**: `DST.defTD` (1) plus the special-teams score (1).

Which is the whole of the `def_td` defect. **`DST.defTD` is the sum of the
players' own `Defense.defTD`** — Marcus Jones is the only player in that game
carrying one, and it is `"1"` — and **ESPN files a punt or kickoff return by a
_defensive_ player there too.** So a unit whose returner happened to be a
defender was paid twice for one touchdown. Six times in 2025, 36 points.

Subtracting gives Tank01's own independent count of the special-teams half, which
is a usable cross-check on our pattern matching and is wired up as one. It is what
would have caught `"Marshawn Kneeland Blocked Punt Recovery in End Zone"` sitting
unrecognised for a season, without a sweep. Refs #157, #158.

**It is narrowed for blocked kicks, and that is a fact about ESPN rather than
about Tank01.** ESPN classifies a blocked-kick touchdown as a **defensive** score
— stat id **93**, "Def. blocked kick for TD" — not as a return, so
`defensiveOrSpecialTeamsTds` holds it **once** where it holds an ordinary return
by a defensive player twice. Measured across 2025: Marcus Jones's punt return
reads `2, 1`, while Jordan Davis's and Will McDonald's blocked-kick touchdowns
read `1, 1` — the subtraction gives 0 where the scoring text legitimately sees 1.
**Four of the season's five blocked-kick touchdowns fired this warning on a game
we score exactly as ESPN does.** Kneeland's is the fifth and reads `1, 0`, because
Tank01 carries no `Defense` block for him at all — which is why the adapter
subtracts only the blocked kicks **already inside `DST.defTD`** rather than all of
them, and why excluding all of them would have moved the quiet game to a warning
while silencing the loud ones.

### What ESPN pays for a defensive or special-teams touchdown

Established 2026-08-17 by reconciling ESPN's own `appliedTotal` arithmetic across
**5 D/ST units and 6 players**. Recorded verbatim because ESPN's public pages
contradict each other, and the scoring table is frozen per league.

| Play                              | Player | D/ST | ESPN files it as             |
| --------------------------------- | ------ | ---- | ---------------------------- |
| Kickoff or punt return TD         | 6      | 6    | return TD **and** def/ST TD  |
| Blocked-kick TD                   | 6      | 6    | 93, Def. blocked kick for TD |
| Kickoff recovered in the end zone | **0**  | 6    | 104, Fumble return TD        |

**Both the returner and the unit are paid** for an ordinary return touchdown —
five independent pairs confirm it: Gibson/NE, Ray Davis/BUF, Nwangwu/NYJ,
Shaheed/SEA, Mims/DEN. The third row is the George Holani play; see
["Recovery" is not a synonym](#recovery-is-not-a-synonym-for-return) for why the
player gets nothing and why Sleeper disagrees.

### `DST.safeties` — what was actually observed

A full-season sweep reported `DST.safeties` as `"0"` for every game including two
with a genuine safety, and this document was going to record that. **It does not
reproduce.** `20250921_ARI@SF` — the sweep's own example, "Defensive Holding in
Endzone for Safety" — returns `DST.away.safeties: "1"` for Arizona today, and the
adapter has always scored that correctly.

What _is_ established from that game:

- `scoreType` is **`"SF"`**, and `team` is the **defense that scored it** —
  Arizona's away score moves 13 → 15 on the play.
- `teamStats.safeties` agrees with `DST.safeties` (`"1"` / `"1"`).

So a safety has two independent readings, and the adapter takes the larger of the
two and **warns on any disagreement** rather than picking a winner between a
measurement it cannot reproduce and one it can. About a dozen safeties a season,
2 points each.

### Individual `Defense.*` fields are not fantasy stats

`Defense.defTD`, `Defense.sacks`, `Defense.defensiveInterceptions` and
`Defense.fumblesRecovered` were mapped to `def_td`, `def_sack`, `def_int` and
`def_fum_rec` **for every player**. There is no IDP slot in this product, so the
only roster spot those keys reach is the D/ST — which is scored from the `DST`
block. A per-player row keyed the same way is a duplicate, not an unused row.

And Tank01 files things under `Defense` that are not defensive plays. A player who
fumbles and falls on his own ball carries `Defense.fumblesRecovered: "1"`. From
`20251103_ARI@DAL`, verbatim:

```
Jacoby Brissett  (QB, ARI)  fumbles "1"  fumblesRecovered "1"  fumblesLost "0"
George Pickens   (WR, DAL)  fumbles "2"  fumblesRecovered "1"  fumblesLost "0"
Javonte Williams (RB, DAL)  fumbles "1"  fumblesRecovered "1"  fumblesLost "1"
```

All three were paid 2 points each. **185 player-weeks of the 2025 season, 384
points.** `Defense.defTD` did the same to Tyler Lockett, a wide receiver, for
"Tyler Lockett 0 Yd Fumble Recovery" in week 5.

**`Defense.fumblesLost` stays mapped.** That one really is the offensive player's
own stat.

### `DST.fumblesRecovered` is the opponent's fumbles lost

Not this unit's recoveries, which is what the name suggests and what the scoring
rule wants. Established 2026-08-17 by separating the two candidate readings
across 22 team-games: they agree on almost all of them, `20251005_TEN@ARI`
discriminates, and the field follows fumbles-lost.

They agree so often because almost every fumble a team loses is recovered by the
opposing defence. **They part company when a defender fumbles during an
interception return and the intercepted team recovers.** ESPN pays the recovering
unit 2 and this field does not see it. Three occurrences over 2024 and 2025,
each confirmed against play-by-play, with Sleeper right in all three:

```
20250925_SEA@ARI    20251130_MIN@SEA    20251208_PHI@LAC
```

**Left as it is, and that is a finding rather than a deferral.** There is no
field in this feed that means "this defence's recoveries":

- `teamStats` has no recovery counter at all — see the full key list above.
- Per-player `Defense.fumblesRecovered` is contaminated by design. A player who
  falls on his own fumble carries it (185 player-weeks of 2025), and a teammate
  recovering a teammate's fumble is indistinguishable from a defender recovering
  an opponent's, so no filter separates them.
- Summing the per-player field and subtracting `own fumbles − own fumbles lost`
  would close the arithmetic, and it is a derivation dressed as a reading: two
  provider fields, one assumption about how fumbles are attributed, and no way to
  check the answer against anything.

A three-team-week undercount that is written down beats a number nobody can
check. If this becomes worth fixing, the fix is a second provider, not a formula.

### `"Recovery"` is not a synonym for `"Return"`

The trap in repairing the blocked-kick wordings above. **Every** fumble-return
touchdown in the 2025 season is worded `"Fumble Recovery"`, not `"Fumble
Return"`, so a bare `recover` alternative in the special-teams pattern looks
equivalent to anchoring on `blocked` and is not. The pattern is anchored on
`blocked`, and there is a test pinning the negative case.

> **Corrected 2026-08-17.** This section said the loose variant "turns **14
> defensive touchdowns** into return touchdowns as well". It does not, and has
> not since #178 widened `DEFENSIVE_RETURN` to
> `/\b(interception|fumble)\s+(return|recovery)\b/i`. Measured over all **2,339**
> scoring plays of the 2025 season: the bare-`recover` variant goes from 26
> matches to **27**, and the single addition is George Holani, below. **Not one
> fumble touchdown leaks** — all **19** of them (17 worded `Fumble Recovery`, 2
> worded `Fumble Return`) match `DEFENSIVE_RETURN`, which
> `isSpecialTeamsReturnTouchdown()` consults first. The anchoring stays, because
> a pattern that is correct only by virtue of a different pattern in front of it
> is one edit away from not being — but the number was wrong and the conclusion
> no longer follows from it.

Still unrecognised on purpose: `"George Holani Recovered Kickoff in End Zone for a
Touchdown"` (#158) — **and that is now a measurement rather than a caution.** A
Seattle kickoff was muffed by Pittsburgh and recovered in the end zone, which is a
coverage-team score rather than a return. **ESPN pays the player 0 and Seattle's
D/ST 6**, filing it under stat id **104**, its fumble-return touchdown; Holani's
ESPN fantasy `appliedTotal` for 2025 week 2 is 0. Tank01 mirrors ESPN —
`Defense.defTD: "1"`, `Kicking.kickReturnTD: "0"`. **Sleeper disagrees** and pays
him `st_td` 6. We score exactly what ESPN scores, so our `ret_td` of 0 is correct.

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

**One, named and measured** — see
[`DST.fumblesRecovered`](#dstfumblesrecovered-is-the-opponents-fumbles-lost),
which undercounts a unit's recoveries by one in three team-weeks across two
seasons and has no substitute in this feed. Everything else in the PPR table is
obtainable:

- ✅ Passing, rushing, receiving, receptions — direct fields
- ✅ Fumbles lost — `Defense.fumblesLost`
- ✅ Extra points — `Kicking.xpMade`
- ✅ Field goals by distance — parsed from scoring plays
- ✅ Two-point conversions — parsed from scoring plays
- ✅ Blocked kicks — **`teamStats`**, floored by the scoring text
- ✅ Defensive points allowed, yards allowed, sacks, interceptions, fumble
  recoveries — the `DST` block
- ✅ Safeties — `DST.safeties`, floored by the `SF` scoring plays
- ✅ Defensive and special teams touchdowns — `DST.defTD` plus the special teams
  scores it does not already contain. **Not a single field**; see
  [`teamStats`](#teamstats--the-second-team-level-block) for why.
- ✅ Defensive two-point conversion returns —
  `teamStats.defensiveTwoPointConversionReturns`
- ⚠️ Fumble recoveries — `DST.fumblesRecovered`, which is really the opponent's
  fumbles lost and is one low when a defender fumbles during a return

Outstanding questions, none blocking:

- **Two-point attribution.** `scoringPlays[].playerIDs` exists but which ID maps
  to passer versus receiver has not been confirmed. Our rules award 2 points for
  pass, rush, _and_ reception, so attribution matters.
- **`getNFLChangelog` returned empty** for a 3-day window. Its behaviour during
  an active season, and whether it is a usable stat-correction signal, is
  untested.
- **Rate limits.** Basic is 1,000 calls/month. A live season is ~700 by our
  estimate, so **Pro ($10/mo) before Week 1** is not optional.
