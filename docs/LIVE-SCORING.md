# Live Scoring

How the incumbents update scores during games, and what this project should do.

---

## The industry pattern

Every major platform runs the same shape. ESPN, Yahoo, and Sleeper ingest feeds from
official vendors — Sportradar and Stats Perform are the usual names — then process,
score, and fan out to clients.

```
provider push feed ─→ ingest ─→ queue ─→ scoring workers ─→ cache ─→ WebSocket ─→ clients
     (streaming)      (validate)  (Kafka/SQS)  (apply rules)   (Redis)   (fan-out)
```

Four properties make it work:

**Push, not poll.** Sportradar offers push feeds to real-time customers: one request
opens a streaming connection and events arrive continuously. Polling adds latency equal
to half your interval on average and wastes most calls on nothing having happened.

**A queue between ingest and scoring.** Events land in Kafka or SQS before anything
consumes them. A slow consumer doesn't block the others; a crashed consumer resumes from
the queue rather than losing a touchdown.

**Recompute, don't increment.** Each event triggers a recalculation of the affected
player's line from the full stat set, not a `+= 6`. Incremental scoring drifts, and
drift in a money league is a support ticket you cannot win.

**In-memory leaderboards.** Standings during a Sunday afternoon change constantly.
They're cached and event-invalidated, never recomputed from Postgres per request.

---

## What this means here specifically

**Live scoring is entirely off-chain, and that is the whole trick.**

The contract only ever sees *finalised* weekly scores — 48 hours after non-paying weeks,
seven days after Weeks 14 and 17. Everything a user watches on Sunday afternoon is
provisional UI. So the real-time pipeline needs no consensus, no oracle, no signatures,
and can be rebuilt or replaced without touching a deployed program.

That decoupling is worth protecting. It means a live-scoring outage is a bad afternoon,
not a settlement failure.

---

## Providers

| Provider | Real-time | Cost | Notes |
|---|---|---|---|
| **Sportradar** | Push feeds, full play-by-play, all games incl. preseason | Not public; industry estimates **$500–1,000+/mo** for one sport. 30-day dev trial. | The reference feed. What the majors actually use. |
| **SportsDataIO** | Real-time on commercial tier | Self-serve **$99–149/mo** but **delayed data + daily call caps**; real-time needs a sales conversation | Self-serve tier is fine for development, not for live Sunday scoring |
| **DataFeeds / Rolling Insights** | Live, "within seconds" | From **$400/mo** | Middle option |
| **Tank01** (RapidAPI) | Live in-game stats, already updated for 2026 | Cheap tiers | Lowest cost path to something that actually works |
| **MySportsFeeds** | Play-by-play | Free for non-commercial | **A paid-entry league is commercial.** Free tier does not apply here. |

The free tiers evaporate the moment there's a pot. That's the real cost of the mainnet
decision, and it should be budgeted rather than discovered in Week 1.

---

## Cost lever: NFL games are concentrated

Unlike soccer or basketball, the NFL plays in tight windows — Thursday night, Sunday
1pm/4pm ET, Sunday night, Monday night. Live infrastructure is genuinely needed for
roughly **12 hours a week**, not continuously.

That permits a hybrid the majors don't bother with because they operate at a scale where
it doesn't matter:

- **In-window** (games live): push feed or aggressive polling, full pipeline hot
- **Out-of-window**: a single daily sync for injuries, transactions, and corrections

Same user experience, a fraction of the API spend.

---

## Recommendation for v1

**Poll, don't push.** Every 20–30 seconds inside game windows. Fantasy scores are not a
trading feed; nobody can tell the difference between a two-second and a twenty-second
update, and users are watching the game on television anyway — the broadcast is *ahead*
of every data feed regardless. Push is a v2 optimisation, and the pipeline shape below
makes swapping it in a change to one module.

**Ship this:**

```
poller (in-window)  →  Postgres stat_lines  →  scoring engine  →  Redis  →  SSE  →  clients
```

- **Server-Sent Events, not WebSockets.** Scoring is one-directional — server to client.
  SSE is a fraction of the complexity, reconnects natively, and works through proxies
  that break WebSockets. Reserve WebSockets for the live draft room, which genuinely is
  bidirectional.
- **Recompute the full player line every tick.** Cheap, and immune to drift.
- **`stat_lines.revision`** is already in the schema. Never overwrite; append. A settled
  week must be auditable against exactly the data it settled on.
- **Provider behind an adapter interface** from the first commit. Every provider above
  will be re-evaluated once there's revenue, and the scoring engine must never know which
  one is behind it.

**Cheapest viable stack for the 2026 season:** Tank01 or the SportsDataIO self-serve tier
for development, upgrading to a real-time commercial tier before Week 1. The second
oracle source required for settlement can be a different provider entirely — settlement
runs once a week on final box scores, not live, so the cheap tier is sufficient there.

---

## Stat corrections

The single most under-appreciated detail, and it changed this project's rules.

ESPN corrects obviously wrong data within minutes. But **official NFL stat corrections
can arrive up to seven days after a game.** A reclassified fumble or a reversed reception
can flip a completed matchup a week later.

On ESPN this is an annoyance. Here it would be a payout to the wrong wallet.

This is why finalisation is two-tier — 48 hours for weeks that only move standings, seven
days for Weeks 14 and 17 where money moves. See [`RULES.md` §7](RULES.md).
