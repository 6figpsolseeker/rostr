# Setup Required

Things only the owner can do — accounts, API keys, payments, decisions. Everything here
blocks something, so each entry records **what it blocks** and **when it is needed**.

Nothing in this list is needed to run `pnpm test`. The whole core is testable without a
single credential.

Status key: ⬜ not started · 🟡 in progress · ✅ done

---

## Blocking soon

### ⬜ Solana RPC endpoint (`SOLANA_RPC_URL`)

**Blocks:** drawing draft orders. Every league needs one draw, at its scheduled draft
time.
**Needed by:** Aug 22 2026, with the first draft.

The draft order is seeded by the first Solana block produced at or after the league's
scheduled draft time — see `docs/RULES.md` §4. Finding it takes about twenty JSON-RPC
calls, once per league, so almost any endpoint will do.

**Free is fine to start.** The public mainnet endpoint
(`https://api.mainnet-beta.solana.com`) is rate-limited but the load here is trivial. A
free Helius or QuickNode key is more reliable and costs nothing at this volume.

> **One caveat worth knowing now.** Public nodes **prune old blocks**. Drawing an order
> works fine, because that happens seconds after the block is produced. But someone
> verifying a draw _months later_ — say, disputing a championship — will get "block not
> available" from a pruned node, which looks identical to a missing block.
>
> If leagues are playing for money, budget for an **archival** RPC plan before the
> playoffs, or record the blockhash somewhere independently checkable. Not urgent in
> August; do not discover it in January.

### ⬜ Email provider (`RESEND_API_KEY`, `EMAIL_FROM`)

**Blocks:** anyone signing in who is not sitting at the dev server.
**Needed by:** before anyone but you uses the app — so, before the first real league.
**Cost:** Resend's free tier is 3,000 emails a month, which is far more than this needs.

Sign-in is a link sent by email. No passwords, so nothing to forget, reuse, or leak.

**Without these set**, the flow still works locally: the link is logged to the server
console and shown in the UI. In **production it fails loudly** rather than pretending to
have sent something — a sign-in that silently goes nowhere is indistinguishable from a
broken account, and the user has no way to tell which it is.

The dev link is only ever returned when `NODE_ENV !== "production"`. Handing a sign-in
link back over the same HTTP response in production would let anyone who can reach the
endpoint sign in as any address they name.

**To do:** sign up at resend.com, verify a sending domain, put the key and a from-address
in `.env`.

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

**Decided 2026-08-05:** no commercial audit firm **for the 2026 season**. The owner has a
professional auditor who will review once the tech is mostly built, and audits Solana
programs himself — `percolator` plus bug bounty submissions on other Solana DeFi
programs.

A commercial audit remains planned, with possible funding through the owner's
connections. It is deferred past the 2026 season, not dropped. That removes the 2–4 week
booking lead time from the critical path without removing review.

**What still limits exposure**, and matters more without a firm's sign-off:

- **A buy-in cap.** The largest single lever: same code and same bug, but a $50 ceiling on
  a 12-person league risks $600 where $500 a head would risk $6,000. Enforced in the
  program, not the UI, so it binds every caller. **Decided 2026-08-07: $5 to $50**, any
  amount in between.
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

### ⬜ Multisig (Squads) — upgrade authority and fee recipient

**Blocks:** deploying the escrow responsibly, and creating any league with a fee.
**Needed by:** **Aug 22**, before mainnet deployment and the first pot league.
**Cost:** free. Squads v4 is the de facto standard on Solana and is formally verified.

One multisig serves two roles. They are worth keeping distinct in your head, because they
fail differently.

**Role 1 — program upgrade authority.** Whoever holds it can replace the program's
bytecode, and the program holds every member's stake. That makes it, functionally, the
ability to drain the escrow without needing an exploit at all: deploy a version whose
`refund_stake` pays somewhere else. A single key means one compromised laptop is every pot.

**Role 2 — fee recipient.** Different failure mode, and the more urgent one. The address is
frozen into every league's hashed rules at creation and can never be changed — that is the
immutability guarantee working exactly as designed, and it cuts both ways. Lose the key and
every fee from every league created before the loss is unrecoverable. There is no admin
override, because the whole architecture exists to ensure there isn't one.

#### Why M-of-N, and which

A single key fails two independent ways: someone else gets it (theft), or you lose it
(loss). `M > 1` covers theft; `N > M` covers loss. One key covers neither.

**Use 2-of-3.** For a solo operator this is not about distrusting a co-founder who does not
exist — it is about surviving a dead drive, a stolen phone, or a house fire.

- **1-of-2** is a single key with extra steps: any one compromised key drains it.
- **3-of-3** is the worst of both — no theft tolerance _and_ no loss tolerance. Lose one and
  everything is frozen permanently.

Three keys that fail **independently**:

1. Hardware wallet (Ledger/Keystone) — the day-to-day signer
2. A key on the main PC, in a password manager
3. A cold backup — seed on paper or steel, stored somewhere physically separate

The usual mistake is putting all three in one password manager. That is a 1-of-1 in
costume.

#### Checklist

- [ ] Create a Squads v4 multisig, 2-of-3, with the three keys above
- [ ] **Record the vault address** — not the config account. A Squads multisig has a config
      account and one or more vault PDAs; the vault is what owns tokens. Putting the config
      account in `fee_recipient` sends every fee somewhere nobody can spend from, forever,
      for every league created with it.
- [ ] Commit the vault address to this repo. It is public information, and a lost note
      should not be able to lose the address.
- [ ] Set `FEE_RECIPIENT` and `NEXT_PUBLIC_FEE_RECIPIENT` to the vault address. Both, and
      the same value — see `.env.example`.
- [ ] **Test recovery before trusting it:** execute a real transaction with _each_ pair of
      keys, not just the convenient pair. A 2-of-3 whose third key was never exercised is a
      2-of-2 you do not know about yet.
- [ ] Rehearse `set-upgrade-authority` on devnet. Pointing it at an address you do not
      control bricks upgradeability instantly and irreversibly.
- [ ] At mainnet deploy:
      `solana program set-upgrade-authority <PROGRAM_ID> --new-upgrade-authority <VAULT>`
- [ ] **Before Dec 13 (Week 14, the first payout):** burn it — set the upgrade authority to
      `None`. The program becomes immutable.

#### Two things to be honest about

Burning upgrade authority removes the trust assumption, and also removes any ability to fix
a bug in code holding real money for another month. What makes that survivable is the
unconditional timelock refund — which is precisely why the build plan says ship that first.

And **a 2-of-3 where one person holds all three keys is not decentralisation.** It is loss
and theft protection for a single operator. The README should say so plainly: "upgrade
authority is a 2-of-3 multisig held by the operator, to be burned before the first payout"
is the accurate sentence. Describing it as "controlled by a multisig" and leaving who holds
the keys unsaid is the kind of thing this project exists not to do.

---

### ⬜ Fee recipient address

**Blocks:** creating a league with a non-zero fee. The program rejects one whose recipient
is the default pubkey, and in production the pot-league route refuses rather than create
leagues that give the fee away.
**Needed by:** **Aug 22**, with the first pot league.

The fee is **1%, taken once at settlement** — decided 2026-08-07, documented in
`docs/RULES.md` § 7, frozen per league in the hashed rule set. What is missing is the
address it pays to. That address is the Squads **vault**; see the multisig entry above,
which is where the decision actually lives.

### ⬜ Pin the USDC mint before mainnet

**Blocks:** nothing on localnet. It is the last gap between the $50 cap and the $50 it is
supposed to mean.
**Needed by:** **before any mainnet deployment**.

The program requires pot tokens to have **six decimals**, which is what makes
`MAX_BUY_IN_BASE_UNITS = 50_000_000` mean fifty dollars rather than fifty million of
something. That is as tight as this can be without a price oracle, and it is **not a proof
of value**: nothing stops a six-decimal token worth far more than a dollar, which would
blow through the cap while satisfying every check.

Pinning USDC's mint address closes it — one constant in `lib.rs`. The reason it is not
done already is that localnet tests cannot mint at a fixed mainnet address, so it needs
either a cluster-conditional constant or an allowlist, and either one wants a moment's
thought rather than being bolted on at deploy time.

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

### ✅ Draft order seed is grindable

**Closed.** The order is now seeded by the first Solana block produced at or after the
league's frozen `scheduledAt` — unknowable while teams are still joining, verifiable by
anyone afterwards.

It needed no Anchor work: reading a block hash is a plain JSON-RPC call, and only
verifying one _inside a program_ would need Rust. It had been parked behind Milestone D
for no reason.

`packages/core/src/draft/seed.ts`, `packages/db/src/randomness.ts`, migration `0010`.
Four mechanisms hold it up and removing any one reopens the attack — see
[`DECISIONS.md`](DECISIONS.md) § "The draft order is drawn from the chain, once".

The one operational leftover is above: verifying an **old** draw needs an archival RPC
node, because public nodes prune.

### ✅ Tank01 API key

Done 2026-08-05. See the entry above for what remains (the Pro upgrade before Week 1).
