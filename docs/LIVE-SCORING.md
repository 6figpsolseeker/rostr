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
> The intent is full automation with no human in the loop.
>
> **This paragraph said "as of 2026-08-17 the loop is entirely human — `cron_runs` holds no
> rows, so no scheduled job has ever executed" and stopped being true when somebody
> deployed.** All seven scheduled jobs fire; `cron_runs` proves it. It went on telling every
> reader to discount every claim in this table, which is the exact failure the **Exists?**
> column was added to prevent, one row up.
>
> **Do not hand-maintain a claim about what is running.** `pnpm cron:status` reads the
> expected jobs out of `vercel.json`, so it cannot be stale; anything written here is a
> snapshot with a date on it. A green result means the routes ran, not that they did any
> work — a run over zero games is a healthy run.
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
| **Game watcher**   | Every 20 min per live game          | Reads box scores from kickoff+20m to +5h       | ✅      | `/api/cron/stats`       |
| **Score finalise** | Same job, on `final`                | Box score → `stat_lines` → recompute → publish | ✅      | `syncBoxScores`         |
| **Week finalise**  | T+48h, or T+7d for Weeks 14 and 17  | Locks the week for settlement                  | ✅      | `/api/cron/score-week`  |

**The game watcher was 🟡 for the wrong reason, and the reason was reassuring.** This row
read _"it does not watch — it polls every ten minutes all week rather than from 2.5 hours
after a kickoff — simpler, and more provider calls."_ The deviation it described was
**over**-polling, a deliberate trade of calls for simplicity.

The truth was the opposite. It polled **zero** games during a game. The box-score work
list gated on `games.status IN ('IN_PROGRESS','FINAL')`, and that column had exactly one
writer — `syncGames`, from the daily 09:20 UTC season sync, which is 05:20 Eastern, an
hour at which no NFL game has ever been in progress. So the status went `SCHEDULED` to
`FINAL` and never through anything in between, the work list matched nothing all Sunday,
and the first stat line for a Sunday slate was written **Monday morning** — 16h30m after
the first kickoff, and 20h for the London games.

Issue #256. Fixed by keying selection on `kickoff_at`, a fact we already hold and every
lineup lock already uses, and by writing `games.status` from the box score's own
`gameStatus` — which the adapter had been discarding. Zero extra provider calls.

The note is kept rather than deleted because of what it cost: it was the one place in the
repo flagging this row as imperfect, it named a cost we were not paying, and it set the
expectation that any fix would _increase_ calls. Anyone reading it would have concluded
the watcher was working and merely inelegant.

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

**The table below was stale by roughly 3× and this note is the correction.** It predates
the 168-hour stat-correction sweep, which alone is the largest line in the budget: a
168-hour window holds two slates, so ~32 games are re-read on the sweep cadence at any
time. It also priced a "game watcher" separately from a "box score fetch", and there is
only one — the watcher _is_ the box-score read, since #256 made the box score the source
of a game's status as well as its stats.

**The binding number is a Sunday, not a week.** The quota is daily (1,000 on Tank01 Pro,
read off a live response header on 2026-08-22, not the free tier's 1,000/month), and the
week's calls are not evenly spread.

| Job                                | Calls, worst Sunday   |
| ---------------------------------- | --------------------- |
| Live box scores (14 games × ~9)    | ~126                  |
| Post-final read (1 per game)       | ~14                   |
| Correction sweep (~32 games @ 12h) | ~64                   |
| Injury sync (hourly)               | 24                    |
| Season sync (daily, 18 weeks + 5)  | 23                    |
| **Total**                          | **~250 of 1,000/day** |

The dial is `LIVE_POLL_MINUTES` in `packages/db/src/box-scores.ts`. At 20 it gives about
nine reads a game; at 180 it gives strictly per-game semantics — one read early, one after
the whistle — at roughly a third of the calls. It governs **freshness only**: the whistle
is observed in-band and the post-final read follows within `FAILED_RETRY_MINUTES`, so the
settled score is right within about twenty minutes of a game ending whatever it is set to.

Every other clause carries its own ceiling and the arithmetic is in that file's comments.
Re-derive them there rather than trusting this table, which has now been wrong once.

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
