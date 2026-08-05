# Setup Required

Things only the owner can do — accounts, API keys, payments, decisions. Everything here
blocks something, so each entry records **what it blocks** and **when it is needed**.

Nothing in this list is needed to run `pnpm test`. The whole core is testable without a
single credential.

Status key: ⬜ not started · 🟡 in progress · ✅ done

---

## Blocking soon

### ⬜ Supabase project

**Blocks:** running anything against a real database. Migrations and their tests run on
PGlite (in-process Postgres, no service) and do not need this.
**Needed by:** after migrations exist — i.e. before the league-creation API is wired up.
**Cost:** free tier is sufficient.

Why hosted rather than local Postgres: the database then follows you between machines.
A local install strands your data on whichever PC you are sitting at, which is the exact
problem this repo's `CLAUDE.md` exists to avoid. It also matches the stack already used in
`percolator-launch` and `percolator-mobile`.

**To do:** create a project, then put the connection string and anon key in `.env`
(see `.env.example`). Do not commit them.

---

### ⬜ IPFS pinning service

**Blocks:** actually pinning a rule document. The pinning client and its adapter interface
can be written and tested against a fake without this.
**Needed by:** before the first real league is created — a league's `rules_uri` must
resolve, or the on-chain hash anchors nothing.
**Cost:** Pinata's free tier is sufficient. web3.storage is an alternative.

**To do:** create an account, generate an API key, add to `.env`.

---

### ⬜ Tank01 API key (RapidAPI)

**Blocks:** the stats provider adapter, and therefore the scoring engine's real fixtures.
**Needed by:** Milestone B, ahead of the **Aug 22** draft deadline.
**Cost:** Basic tier is **free** (1,000 calls/month) and is enough for development.
Pro is **$10/month** and is what production should run on.

See [`LIVE-SCORING.md`](LIVE-SCORING.md) for why Tank01 is the primary feed.

---

### ⬜ Security audit — escrow program

**Blocks:** pot leagues opening. **This is the long pole on the critical path.**
**Needed by:** engaged in **week one**; an audit is 2–4 weeks of calendar time no amount
of effort compresses, and pot leagues must be fundable by **Aug 22**.
**Cost:** significant. Budget accordingly.

If this slips, the fallback is free-to-play leagues for 2026 with the pot enabled once
audited. That is the single largest available risk reduction and it is better taken early
than late.

**To do:** get quotes now, before the program is finished. Auditors book out.

---

## Blocking later

### ⬜ SportsDataIO subscription

**Blocks:** gameday inactives, and the independent second oracle source that settlement
requires.
**Needed by:** inactives matter from **Week 1 (Sep 9)**; the oracle role matters from
**Week 14 (Dec 13)**, the first paying week.
**Cost:** $99–149/month self-serve.

One line item, two jobs. Tank01 refreshes injuries hourly, which is fine for weekly injury
designations but weak for inactives — those drop 90 minutes before kickoff.

---

### ⬜ Multisig for program upgrade authority

**Blocks:** deploying the escrow program responsibly.
**Needed by:** before mainnet deployment, **Aug 22**.
**Cost:** free (Squads or similar).

The upgrade authority must not be a single key while the program holds user funds. It
gets burned entirely once settlement is audited, before Week 14 pays out.

---

### ⬜ Buy-in cap for season one

**Blocks:** nothing technically — it is a number in the program config.
**Needed by:** **Aug 22**, at deployment.

A decision, not a task: what is the maximum a league may put into a contract this new?

---

## Decisions outstanding

### ⬜ Bot draft sophistication

Queue-and-fallback is specified and cheap. Bots that draft _believably_ — positional
scarcity, bye weeks, tier breaks — are a genuinely fun sub-project but a real amount of
work. Where is the line?

**Needed by:** Milestone B, before **Aug 22**.

### ⬜ Does the NOT AUDITED banner stay at the top of the README?

Currently it does. It is the first thing anyone sees on a public repo. Raised twice, not
yet answered.

### ⬜ Local folder rename

The clone on the secondary PC is still at `C:\Users\rebef\dev\gridiron`; the project is
`rostr`. Windows would not rename it while VS Code held the folder. Cosmetic — close the
editor and rename, or just re-clone.

---

## Done

_(nothing yet)_
