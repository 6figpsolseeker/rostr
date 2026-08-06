# Setup Required

Things only the owner can do — accounts, API keys, payments, decisions. Everything here
blocks something, so each entry records **what it blocks** and **when it is needed**.

Nothing in this list is needed to run `pnpm test`. The whole core is testable without a
single credential.

Status key: ⬜ not started · 🟡 in progress · ✅ done

---

## Blocking soon

### ⬜ Supabase project

**Blocks:** the web app past its home page, and the session that league creation and
joining both need. Migrations and their tests run on PGlite (in-process Postgres, no
service) and do not need this.
**Needed by:** now. This is the current blocker.

**Cost:** Free ($0) is fine for development — 500 MB database, 5 GB egress, 50k monthly
active users, 2 active projects. Our data is tiny.

**But free projects pause after one week with no API requests.** Data is retained and
resuming is manual. Harmless during development; unacceptable in December with money in
escrow and someone trying to set a playoff lineup.

> **Move to Pro ($25/mo) before Week 1.** Nothing in the schema or code changes — it is a
> billing switch.

Why hosted rather than local Postgres: the database then follows you between machines.
A local install strands your data on whichever PC you are sitting at, which is the exact
problem this repo's `CLAUDE.md` exists to avoid. It also matches the stack already used in
`percolator-launch` and `percolator-mobile`.

> **Decided: the owner is setting this up on their main PC.** Nothing is blocked on the
> secondary machine in the meantime — the whole core, including the scoring engine, is
> testable against PGlite with no credentials.

The project lives on Supabase's servers, so which machine creates it makes no difference
to the result. The credentials go in `.env`, which is gitignored, so they must be copied
to each machine by hand — move them through a password manager, not chat or email. Sign up
with the same email as GitHub so the account does not get orphaned.

**To do:**

1. Create a project at supabase.com.
2. Put its connection string in `.env` as `DATABASE_URL` (see `.env.example`).
3. `pnpm db:migrate` — applies the schema.
4. `pnpm db:seed` — inserts the NFL registry.
5. `pnpm db:status` — confirms what is applied.

---

### ⬜ IPFS pinning service

**Blocks:** actually pinning a rule document. The pinning client and its adapter interface
can be written and tested against a fake without this.
**Needed by:** before the first real league is created — a league's `rules_uri` must
resolve, or the on-chain hash anchors nothing.
**Cost:** Pinata's free tier is sufficient. web3.storage is an alternative.

**To do:** create an account, generate an API key, add to `.env`.

---

### ✅ Tank01 API key (RapidAPI)

**Done 2026-08-05.** Key is in `.env` as `TANK01_API_KEY`. Verify any time with
`pnpm stats:check`, and inspect live response shapes with `pnpm stats:probe`.

**Still to do: upgrade to Pro ($10/month) before Week 1.** Basic allows 1,000 calls a
month and the estimate for a live season is ~700 — too close to the ceiling once real
leagues are running, and exceeding it stops scoring mid-week.

Both gaps flagged on first mapping are now **resolved** — two-point conversions and
blocked kicks are both obtainable, from the play-by-play. See
[`TANK01.md`](TANK01.md) for the full digest, verified across 96 real games.

---

### 🟡 Security review — escrow program

**Decided 2026-08-05:** no commercial audit firm. The owner has a professional auditor
who will review once the tech is mostly built, and audits Solana programs himself —
`percolator` plus bug bounty submissions on other Solana DeFi programs.

That is a real review path rather than a skipped one, and it removes the 2–4 week
booking lead time that previously sat on the critical path.

**What still limits exposure**, and matters more without a firm's sign-off:

- **A buy-in cap.** The largest single lever: same code and same bug, but a $25 cap on a
  12-person league risks $300 where a $500 cap risks $6,000. Enforced in the program, not
  the UI. **Amount still to be decided.**
- **The unconditional timelock refund.** Turns "funds are gone" into "funds are stuck
  until a date". Non-negotiable.
- **Kani proofs.** Already used on `percolator-stake` and `percolator-match`. Free, and
  it catches the class of bug that drains escrows.
- **The disclaimer belongs in the signed rules**, not a banner — members already sign the
  rules hash to join, so an unaudited warning inside the rule set is cryptographically
  acknowledged rather than dismissed.

**Roster NFTs stay in scope** (Milestone E). They were floated as a cut and the owner
declined.

**Timing note, stated once:** review happens after the program is written, so for an
Aug 22 launch it lands close to or after the first deposits. Worth knowing; the caps
above are what make that tolerable.

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

## Running cost, once live

| Item                                            | Monthly       |
| ----------------------------------------------- | ------------- |
| Supabase Pro                                    | $25           |
| Tank01 Pro — stats, box scores, news            | $10           |
| SportsDataIO — inactives + second oracle source | $99–149       |
| **Total**                                       | **~$135–185** |

Plus the escrow audit, which is a one-off and materially larger. Data cost does not scale
with users — one box score is scored against every league — so this figure holds whether
there are ten leagues or ten thousand.

Dropping the pot removes both the audit and the SportsDataIO oracle requirement, taking
the running cost to roughly **$35/month**.

---

## Known gaps

### ⬜ Draft order seed is grindable

**Blocks:** a fair draft in any league with a pot.
**Needed by:** **Aug 22**, with the draft.

The order is a seeded shuffle, so it is auditable. But it depends on the seed _and_ the
set of team IDs, and a commissioner can vary the latter: add a bot, compute the resulting
order, remove it, try again until it favours them. Undetectable afterwards.

The fix is a seed nobody can know until the field is locked — **a Solana slot hash at or
after the frozen `draft.scheduledAt`**. Unpredictable in advance, verifiable after.
Needs the chain integration, so it is currently blocked alongside Milestone D.

Until then, treat the order as fair only for free leagues.

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
