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

| Trigger | Roughly |
|---|---|
| Thursday night game final | Thu ~11:30pm ET |
| Sunday 1pm slate final | Sun ~4:15pm ET |
| Sunday 4pm slate final | Sun ~7:30pm ET |
| Sunday night game final | Sun ~11:30pm ET |
| Monday night game final | Mon ~11:30pm ET |

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
which runs *ahead* of every data feed — so the app is always behind what they already
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

Fully automated. No human in the loop at any point.

The NFL schedule is published in May, so **every kickoff time is known months ahead**.
That makes the whole thing schedule-driven rather than reactive:

| Job | Fires | Does |
|---|---|---|
| **Season sync** | Daily, 4am | Players, teams, byes, schedule changes |
| **Injury sync** | Every 6h, and hourly on game days | Injury designations |
| **Inactives** | **100 minutes before each kickoff** | Official inactive list — see below |
| **Game watcher** | 2.5h after each kickoff, then every 10 min | Polls until status is `final` |
| **Score finalise** | On `final` | Box score → `stat_lines` → recompute → publish |
| **Week finalise** | T+48h, or T+7d for Weeks 14 and 17 | Locks the week for settlement |

The game watcher is the only job that polls, and only from 2.5 hours after kickoff until
the game ends — roughly 20–40 minutes of polling per game.

### Inactives matter more than live scoring

Teams must submit inactive lists **90 minutes before kickoff**. That data changes what
users *do* — whether to bench a questionable starter — where live scoring only changes
what they *watch*.

If the data budget only covers one timely feed, it should be this one.

**Provider refresh rates are the binding constraint here, not our polling.** Tank01
states:

| Data | Refresh |
|---|---|
| Games, box scores | Immediately, as they happen |
| Player news, headlines | Multiple times per hour |
| Rosters — injuries refresh with them | **Hourly** |

Hourly is fine for the Wednesday–Friday injury designations. It is *not* fine for
gameday inactives:

```
T-90   inactives released by teams
T-89   best case — Tank01 refreshes just after
T-30   worst case — previous refresh landed at T-91
T-0    kickoff, lineup locks
```

Users would get 25–90 minutes of warning, median ~55. ESPN and Sleeper get it at T-90.
Tank01 also only *guarantees* `teamID`, `teamAbv`, and `playerID` on the roster endpoint,
with other metadata varying, and documents no dedicated inactives endpoint.

**Mitigation, at no additional cost:** SportsDataIO documents an explicit `Inactive`
field available ~90 minutes before kickoff — and is already budgeted as the independent
second oracle source. One line item, two jobs. Additionally, poll Tank01's **news**
endpoint through the pre-kickoff window: it refreshes multiple times an hour, and
breaking "ruled out" reports land there before the roster reflects them.

---

## Cost

### Call volume

The critical property: **data cost is O(games), not O(users).**

Jalen Hurts' box score is fetched once and scored against every league in the system.
Ten leagues or ten thousand, the API bill is identical. Data spend is fully decoupled
from growth.

Per week, in season:

| Job | Calls/week |
|---|---|
| Game watcher polling | ~70 |
| Box score fetch (16 games) | 16 |
| Inactives (4 kickoff windows) | ~48 |
| Injury sync | ~30 |
| Season/roster sync | 7 |
| **Total** | **~170/week ≈ 700/month** |

### Providers

| Tier | Cost | Verdict |
|---|---|---|
| **Tank01 Basic** (RapidAPI) | **Free** — 1,000 calls/month | Fits development. No credit card. |
| **Tank01 Pro** | **$10/mo** — 1,000/day (~30,000/mo) | **40× headroom at per-game; still fits 30s polling.** |
| Tank01 Ultra | $25/mo — 15,000/day | Only if polling gets genuinely aggressive |
| SportsDataIO self-serve | $99–149/mo — delayed, call-capped | **Inactives + second oracle source** |
| Sportradar | ~$500–1,000+/mo | Push feeds. Not needed here. |

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

| Phase | Monthly |
|---|---|
| Development | **$0** (Tank01 Basic) |
| 2026 season, single source | **$10** |
| 2026 season with settlement redundancy | **$110–160** |

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
