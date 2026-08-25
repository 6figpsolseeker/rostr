# Scoring Updates

How the incumbents update scores during games, what this project does instead, and what
it costs.

---

## The industry pattern

Every major platform runs the same shape. ESPN, Yahoo, and Sleeper ingest feeds from
official vendors — Sportradar and Stats Perform are the usual names — then process,
score, and fan out to clients.

```
provider push feed ─→ ingest ─→ queue ─→ scoring workers ─→ cache ─→ WebSocket ─→ clients
     (streaming)      (validate)  (Kafka/SQS)  (apply rules)   (Redis)   (fan-out)
```

Sportradar offers push feeds to real-time customers: one request opens a streaming
connection and events arrive continuously. It is genuinely excellent, and it costs an
estimated **$500–1,000+/month** for a single sport.

We are not doing that.

---

## What this project does: per-game updates

Scores refresh when each game **finishes**, not continuously. Across a typical week:

| Trigger                   | Roughly         |
| ------------------------- | --------------- |
| Thursday night game final | Thu ~11:30pm ET |
| Sunday 1pm slate final    | Sun ~4:15pm ET  |
| Sunday 4pm slate final    | Sun ~7:30pm ET  |
| Sunday night game final   | Sun ~11:30pm ET |
| Monday night game final   | Mon ~11:30pm ET |

Five to six updates a weekend instead of several hundred.

### Why this costs nothing structurally

Live scoring is **pure UX**. It has no bearing on correctness, settlement, or money:

- Head-to-head matchups need only **end-of-week totals**. The weekly result is identical
  whether the score arrived in one update or four hundred.
- The chain sees only **finalised** scores — 48 hours later for standings weeks, seven
  days for Weeks 14 and 17.
- Lineup lock is driven by the **schedule**, not the stat feed. Kickoff times are known
  months ahead.

No rule in [`RULES.md`](RULES.md) changes as a result of this decision.

### What it costs in experience

Honestly: watching a score tick up during the 1pm slate is why people open a fantasy app
forty times on a Sunday. Per-game updates lose that. Users are watching on television —
which runs _ahead_ of every data feed — so the app is always behind what they already
know.

Per-game keeps the scoreboard moving through the day without paying real-time prices.
It is a deliberate trade, not an oversight.

### It stays reversible — and cost is not the constraint

**The fetch interval is a config value, not an architecture.** The pipeline is identical
either way:

```
fetch stat lines → store with revision → recompute → publish
```

Whether that fires every 30 seconds or once after a game is one number.

Worth being precise about the economics, because it is easy to assume real-time means
Sportradar money. It does not. Tank01 updates **box scores immediately as they happen**,
and 30-second polling through game windows is roughly **6,700 calls/month** — inside the
**$10/month** Pro tier.

Per-game remains the right v1 choice for simplicity and fewer failure modes. But the
reason is build time and operational surface, **not cost**. It can be revisited any
Sunday by changing a number.

---

## Automation

> **This section is the design. Read it in the future tense.**
>
> The intent is full automation with no human in the loop. As of **2026-08-17 the loop is
> entirely human**: `cron_runs` holds no rows, so no scheduled job has ever executed
> against the deployed database, and every sync so far was somebody running `pnpm db:sync`.
> Check with `pnpm cron:status`. The deployment this waits on is an entry in
> `docs/SETUP-REQUIRED.md`.
>
> Five of the six jobs below exist as code. One does not exist at all. The **Exists?**
> column says which — added because this table read as a description of production for
> months, and `CLAUDE.md` names that mistake as how a false claim survived being repeated.
>
> Injury sync moved from ❌ to ✅ on 2026-08-25. **Inactives is the one still missing**, and
> it is the one this document argues matters most.

The NFL schedule is published in May, so **which teams play, and on what date, is known
months ahead**. The _hour_ is not: late-December kickoffs are held back for flex
scheduling and fixed last. Verified against Tank01 on 2026-08-17 — those fixtures arrive
with `gameDate` set and `gameTime: "TBD"`, `gameTime_epoch: ""`, so the day is known and
the hour is not.

That still makes the whole thing schedule-driven rather than reactive. But an ingest that
_requires_ a kickoff time silently drops the games in the two weeks that decide a season,
and it did: eight fixtures across weeks 16 and 17 of 2026. See `games.kickoff_tbd`
(migration `0030`) and `gameAvailability` in `@rostr/core`.

| Job                | Fires                               | Does                                           | Exists? | Where                   |
| ------------------ | ----------------------------------- | ---------------------------------------------- | ------- | ----------------------- |
| **Season sync**    | Daily, 09:20 UTC                    | Players, byes, schedule, rankings, projections | ✅      | `/api/cron/season-sync` |
| **Injury sync**    | **Hourly**                          | Injury designations                            | ✅      | `/api/cron/injuries`    |
| **Inactives**      | **100 minutes before each kickoff** | Official inactive list — see below             | ❌      | —                       |
| **Game watcher**   | Every 10 min, unconditionally       | Polls until status is `final`                  | 🟡      | `/api/cron/stats`       |
| **Score finalise** | Same job, on `final`                | Box score → `stat_lines` → recompute → publish | ✅      | `syncBoxScores`         |
| **Week finalise**  | T+48h, or T+7d for Weeks 14 and 17  | Locks the week for settlement                  | ✅      | `/api/cron/score-week`  |

**The game watcher is 🟡 because it does not watch.** It polls every ten minutes all week
rather than from 2.5 hours after a kickoff — simpler, and more provider calls. The
2.5-hour window described below is the design, not the code.

**Injury sync exists** (`packages/db/src/injuries.ts`, `/api/cron/injuries`, hourly). It
runs hourly rather than the 6h/game-day split described above, which is simpler and costs
more calls — the same trade the game watcher makes, and noted here so the row is not read
as conformance with the plan beside it.

Two properties of it are load-bearing and easy to undo: it **refuses an empty provider
list**, because "no injuries anywhere in the league" and "the feed returned nothing" are
indistinguishable in the response and only one of them should clear every designation in
the database; and it **reports `providerReturned`**, so a quiet run can be told from a
broken one. A designation is shown and never enforced — `RULES.md` §6 locks a slot at that
player's own kickoff and says nothing about fitness.

**Inactives still has no code at all**, and it is the one this document argues matters
most.

### Inactives matter more than live scoring

Teams must submit inactive lists **90 minutes before kickoff**. That data changes what
users _do_ — whether to bench a questionable starter — where live scoring only changes
what they _watch_.

If the data budget only covers one timely feed, it should be this one.

**Provider refresh rates are the binding constraint here, not our polling.** Tank01
states:

| Data                                 | Refresh                     |
| ------------------------------------ | --------------------------- |
| Games, box scores                    | Immediately, as they happen |
| Player news, headlines               | Multiple times per hour     |
| Rosters — injuries refresh with them | **Hourly**                  |

Hourly is fine for the Wednesday–Friday injury designations. It is _not_ fine for
gameday inactives:

```
T-90   inactives released by teams
T-89   best case — Tank01 refreshes just after
T-30   worst case — previous refresh landed at T-91
T-0    kickoff, lineup locks
```

Users would get 25–90 minutes of warning, median ~55. ESPN and Sleeper get it at T-90.
Tank01 also only _guarantees_ `teamID`, `teamAbv`, and `playerID` on the roster endpoint,
with other metadata varying.

### Tank01 does have a dedicated inactives endpoint — `getNFLInactiveList`

**This paragraph used to say it had none.** That was true of the documentation when this
was written and is not true of the API. Probed live on 2026-08-15:

```
GET getNFLInactiveList?season=2026&seasonType=reg

{ seasonType, season, weekList: [ { gameWeek, inactives: [
    { gameID, home: { teamAbv, teamID, players[] },
              away: { teamAbv, teamID, players[] } } ] } ] }
```

**One call returns the whole season** — 18 weeks, 272 games, keyed by `gameID` with a
per-team `players` array. That is the shape this section wanted: per game, per team, and
cheap enough to poll through the pre-kickoff window without a per-game fan-out. A `week`
parameter is accepted and appears to be ignored; the response carries all eighteen either
way.

**Two things are unverified, and they are the two that decide whether it replaces
SportsDataIO for this job:**

1. **What a populated `players[]` entry contains.** All 272 are empty today because the
   2026 season has not started, and `season=2025` answers _"no games returned"_ — the
   endpoint appears to serve only the current season, so there is no history to inspect.
   Whether an entry carries `playerID` (which is what the roster join needs) or only a
   name is unknown.
2. **When it fills.** The entire argument above is T-90 versus T-30. An endpoint that
   exists but refreshes on the same hourly roster cycle solves nothing.

Both are answerable on the first gameday and not before. Note the season opener is
`20260909_NE@SEA` — **9 September 2026**, which is the live-scoring deadline itself, so
this cannot be settled ahead of it with real data.

**Mitigation, unchanged until those two are answered:** SportsDataIO documents an explicit
`Inactive` field available ~90 minutes before kickoff — and is already budgeted as the
independent second oracle source. One line item, two jobs. Additionally, poll Tank01's
**news** endpoint through the pre-kickoff window: it refreshes multiple times an hour, and
breaking "ruled out" reports land there before the roster reflects them.

**What changes if `getNFLInactiveList` fills at T-90 with player ids:** it does that job on
the plan already paid for, and SportsDataIO's justification narrows to the one it cannot
shed — being the _independent second source_ the settlement oracle requires (`RULES.md` §7).
That is a smaller claim than "one line item, two jobs", and the budget conversation should
be had against the smaller one.

---

## Cost

### Call volume

The critical property: **data cost is O(games), not O(users).**

Jalen Hurts' box score is fetched once and scored against every league in the system.
Ten leagues or ten thousand, the API bill is identical. Data spend is fully decoupled
from growth.

Per week, in season:

| Job                           | Calls/week                |
| ----------------------------- | ------------------------- |
| Game watcher polling          | ~70                       |
| Box score fetch (16 games)    | 16                        |
| Inactives (4 kickoff windows) | ~48                       |
| Injury sync                   | ~30                       |
| Season/roster sync            | 7                         |
| **Total**                     | **~170/week ≈ 700/month** |

### Providers

| Tier                        | Cost                                | Verdict                                               |
| --------------------------- | ----------------------------------- | ----------------------------------------------------- |
| **Tank01 Basic** (RapidAPI) | **Free** — 1,000 calls/month        | Fits development. No credit card.                     |
| **Tank01 Pro**              | **$10/mo** — 1,000/day (~30,000/mo) | **40× headroom at per-game; still fits 30s polling.** |
| Tank01 Ultra                | $25/mo — 15,000/day                 | Only if polling gets genuinely aggressive             |
| SportsDataIO self-serve     | $99–149/mo — delayed, call-capped   | **Inactives + second oracle source**                  |
| Sportradar                  | ~$500–1,000+/mo                     | Push feeds. Not needed here.                          |

**Primary feed: Tank01 Pro at $10/month.** Already updated for the 2026 season; box
scores, injuries, news, and projections.

### The second source earns its cost twice

Settlement requires two independent providers to agree before a paying week finalises.
That runs **once a week on final box scores** — not live — so it could sit on the
cheapest tier available.

But SportsDataIO also documents the explicit `Inactive` field at ~90 minutes before
kickoff, which is precisely Tank01's weakest point. So the same **$99–149/month** covers
both settlement redundancy and the one feed where timeliness genuinely affects user
decisions. Worth paying for that reason alone.

ESPN's undocumented public endpoints are free and widely used, but unofficial,
unsupported, and carry terms-of-service risk for a commercial product. Useful for
development fixtures and as a human tiebreak signal when providers disagree — never in
the automated path that decides who gets paid.

### Bottom line

| Phase                                  | Monthly               |
| -------------------------------------- | --------------------- |
| Development                            | **$0** (Tank01 Basic) |
| 2026 season, single source             | **$10**               |
| 2026 season with settlement redundancy | **$110–160**          |

For context: the real-time architecture the majors run would be **$500–1,000+/month**,
for a feature that has no effect on who wins.

---

## Implementation notes

- **Provider behind an adapter interface** from the first commit. Every provider here
  gets re-evaluated once there's revenue, and the scoring engine must never know which
  one is behind it.
- **Recompute the full player line each update.** Never increment. Incremental scoring
  drifts, and drift in a money league is an argument you cannot win.
- **`stat_lines.revision` is append-only.** A settled week must be auditable against
  exactly the data it settled on.
- **SSE, not WebSockets**, for publishing score updates. One-directional, far less
  complexity, reconnects natively, survives proxies that break WebSockets. WebSockets are
  reserved for the live draft room, which genuinely is bidirectional.

---

## Stat corrections

The single most under-appreciated detail, and it changed this project's rules.

ESPN corrects obviously wrong data within minutes. But **official NFL stat corrections
can arrive up to seven days after a game.** A reclassified fumble or a reversed reception
can flip a completed matchup a week later.

On ESPN this is an annoyance. Here it would be a payout to the wrong wallet.

Hence two-tier finalisation — 48 hours for weeks that only move standings, seven days for
Weeks 14 and 17 where money moves. See [`RULES.md` §7](RULES.md).
