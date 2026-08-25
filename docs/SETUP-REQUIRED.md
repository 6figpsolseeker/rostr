# Setup Required

Things only the owner can do — accounts, API keys, payments, decisions. Everything here
blocks something, so each entry records **what it blocks** and **when it is needed**.

Nothing in this list is needed to run `pnpm test`. The whole core is testable without a
single credential.

Status key: ⬜ not started · 🟡 in progress · ✅ done

---

## Blocking soon

### ✅ A deployment, and `CRON_SECRET`

**Done, and this entry said otherwise until 2026-08-19.** It was written on 2026-08-17
when nothing had ever run, and never updated when the deployment happened — so it went
on reading as the blocker for the whole season. An agent trusted it over the evidence
and told the owner there was no deployment. **A missing `.vercel` directory is not
evidence of anything**: a GitHub-integrated project creates no local link.

Verified 2026-08-19 by `gh api repos/6figpsolseeker/rostr/deployments` (19 of them,
Production building on every push to `main`) and by `pnpm cron:status` against the
hosted database:

```
OK         draft-tick    every 1m       last: 0m ago
OK         stats         every 10m      last: 8m ago
NEVER_RAN  score-week    every 10m      last: never
OK         waivers       every 60m      last: 49m ago
OK         trades        every 60m      last: 47m ago
FAILING    season-sync   every 1440m    last: 1284m ago — 16 fixtures awaiting a kickoff time
```

Four jobs stamping recent heartbeats settles the two traps this entry used to warn
about: **Root Directory is `apps/web`** (otherwise no cron would be registered at all)
and **`CRON_SECRET` is set** (otherwise `cronForbidden` would refuse every one).

**The two unhealthy rows are not deployment problems.** Both are real and neither blocks
anything:

- **`score-week` reads `NEVER_RAN` and that is a heartbeat defect, not a dead job.**
  `route.ts` returns early with `{week: null, leagues: []}` when no NFL game has kicked
  off yet, and that path never calls `recordCronRun`. So a job firing every ten minutes
  and correctly doing nothing is **indistinguishable from one that is not scheduled** —
  which is exactly what the heartbeat exists to tell apart. The `catch` block three lines
  above stamps and rethrows for precisely this reason, and its comment says so; the early
  return was missed. It will start reporting on its own once a game kicks off on Sep 9,
  which means the gap closes by accident rather than being fixed.
- **`season-sync` reads `FAILING` on fixtures the NFL has deliberately not scheduled.**
  Production holds 8 such games — 4 in week 16, 4 in week 17 — flagged `kickoff_tbd`,
  which is the flex-scheduling case #182 was written to keep rather than discard. A
  permanent and correct condition reported as a failure every day trains people to ignore
  the row.

**Still genuinely open here:** whether the plan tier sustains six jobs at minute
granularity, and the `season-sync` function timeout against eighteen weeks of provider
calls in one invocation. The **Running cost** table below still has no hosting line.

> **A green `pnpm cron:status` means the routes ran, not that they did any work.** A run
> over zero games is a healthy run. Every game in the database is still `SCHEDULED`,
> `stat_lines` is empty, and every player scores zero until Sep 9. That is a separate
> check and this is not it.

### ✅ The migration numbering collided, and was resolved

**Resolved 2026-08-19, the day it was found.** `pnpm db:migrate` had stopped: version 32
was `player_profiles` in the hosted database and `the_season_was_declared_started` on
disk. Two branches numbered independently and **both reached a real database** — the
collision `packages/db/migrations/README.md` warns about. CI's guard cannot catch this
one: it compares a branch against `main`, never against what a database has already run.

**Fixed by renumbering on disk to match what production actually ran** —
`player_profiles` back to `0032`, `the_season_was_declared_started` to `0033`. Editing a
merged migration's number is normally forbidden; here it resolved a collision rather than
causing one, and it was safe because the two are independent (`players` versus
`leagues`, no shared object, no ordering dependency) and because
`the_season_was_declared_started` had been applied nowhere.

Verified against the schema rather than the runner's own report:

```
schema_migrations   33=the_season_was_declared_started  32=player_profiles
leagues             season_started_at, season_start_signature, season_start_cluster
trigger             leagues_season_start_immutable
```

**The lesson worth keeping: `pnpm db:status` compares by version _number_.** Through the
whole collision it reported `0032` applied and `0033` pending — both technically true
and both misleading, because the _names_ had swapped underneath. Only `db:migrate`
compares names, and only `information_schema` answers what a database actually has.
When a migration question matters, read the schema.

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

### ⬜ Devnet SOL, to deploy the escrow program somewhere a wallet can reach

**Blocks:** trying the anchor flow in a browser, and any testing that is not you and me
on one machine.
**Needed by:** before Aug 22, and worth doing sooner — it is how anyone else sees this
work at all.

The program is deployed to a **local validator only**, and a browser wallet can only
reach that if it lets you point it at an arbitrary RPC URL. Solflare exposes a custom
endpoint setting; Phantom's network list has moved around between versions, so check
before assuming. Devnet sidesteps the question entirely, because every wallet offers it.

Deploying costs roughly **2.5 SOL** on devnet for a 319 KB program. The CLI faucet is
rate-limited and returned nothing on 2026-08-09; the web faucet at
<https://faucet.solana.com> gives more, and needs a GitHub sign-in.

Fund this address, which is the deploy keypair on the main PC:

```
AoF2r5NttSS9A8DtzzTyB1nHxSX9PDMa7txowGvHqWn7
```

Then `anchor deploy --provider.cluster devnet`, and set **`SOLANA_CLUSTER=devnet`** and
**`NEXT_PUBLIC_SOLANA_CLUSTER=devnet`**. Those are the declarations; the two RPC URLs are
optional and are checked against them.

They must agree — the browser anchors against one endpoint and the server verifies
against the other, and the PDA is identical on every cluster, so a mismatch looks like a
league that will not verify rather than like a misconfiguration. **The agreement is now
enforced rather than requested**: the server asks its RPC for a genesis hash before
recording anything, and the browser shows a "wrong network" banner when its endpoint
disagrees with the build. `SOLANA_CLUSTER` is **required in production** — unset, it used
to mean "do not check the cluster", so the deployment nobody had configured was the one
with no check.

Devnet SOL is free and worth nothing; this is a rate limit, not a cost.

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

### ✅ Supabase project

**Done 2026-08-06.** The connection string is in `.env` (gitignored, never committed) and
points at a session pooler on port 5432, which is what `packages/db/migrations/README.md`
requires. This entry read "⬜ … Needed by: now. This is the current blocker" until
2026-08-14, eight days after it stopped being true.

**Migrations are not applied automatically.** `ci.yml` has no Postgres service and never
runs `db:migrate`; every test builds a fresh in-process PGlite database. So the hosted
database only advances when somebody runs `pnpm db:migrate` by hand, and it drifts behind
`main` in the meantime — on 2026-08-14 it held through version 20 while `main` carried 0027. `pnpm db:status` tells you which; run it before assuming either way.

**Still to do here:** move to Pro before Week 1, per the note below.

**Blocks:** nothing now. Historically: the web app past its home page, and the session that
league creation and joining both need. Migrations and their tests run on PGlite (in-process
Postgres, no service) and never needed this.

**Cost:** Free ($0) is fine for development — 500 MB database, 5 GB egress, 50k monthly
active users, 2 active projects. Our data is tiny.

**But free projects pause after one week with no API requests.** Data is retained and
resuming is manual. Harmless during development; unacceptable in December with money in
escrow and someone trying to set a playoff lineup.

> **Move to Pro ($25/mo) before Week 1.** Nothing in the schema or code changes — it is a
> billing switch.

Why hosted rather than local Postgres: the database then follows you between machines.
A local install strands your data on whichever PC you are sitting at, which is the exact
problem this repo's `CLAUDE.md` exists to avoid.

> **Decided: the owner is setting this up on their main PC.** Nothing is blocked on the
> secondary machine in the meantime — the whole core, including the scoring engine, is
> testable against PGlite with no credentials.

The project lives on Supabase's servers, so which machine creates it makes no difference
to the result. The credentials go in `.env`, which is gitignored, so they must be copied
to each machine by hand — move them through a password manager, not chat or email. Sign up
with the same email as GitHub so the account does not get orphaned.

**Done, and kept as the recipe for the second machine** — the credentials are per-machine
because `.env` is gitignored, so a fresh checkout still needs steps 2 onward:

1. ~~Create a project at supabase.com.~~ Done 2026-08-06.
2. Put its connection string in `.env` as `DATABASE_URL` (see `.env.example`). Move it
   through a password manager, not chat or email.
3. `pnpm db:status` — **first**, not last. It tells you what the hosted database already
   has, and running `db:migrate` blind is how a forward-only runner meets a surprise.
4. `pnpm db:migrate` — applies whatever is pending.
5. `pnpm db:seed` — inserts the NFL registry.

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

**The key is no longer on the free tier** — confirmed by the owner on 2026-08-22.
This entry said an upgrade was still to do, and repeating that sent a session
diagnosing a failed sync straight to the wrong conclusion.

**Read the plan from the response, never from here.** Every Tank01 reply carries
`X-RateLimit-Requests-Limit`, `-Remaining` and `-Reset`, and those are the only
current statement of what the key may do:

```
curl -s -o /dev/null -D - "https://$TANK01_HOST/getNFLTeams" \
  -H "X-RapidAPI-Key: $TANK01_API_KEY" -H "X-RapidAPI-Host: $TANK01_HOST" |
  grep -i ratelimit
```

On 2026-08-22 that answered 998 of 1000 remaining with the window resetting in
about fifteen hours — a **daily** allowance rather than the monthly one this file
used to describe. Which plan that corresponds to is on the RapidAPI dashboard;
it is not inferable from the headers and should not be guessed at here again.

Both gaps flagged on first mapping are now **resolved** — two-point conversions and
blocked kicks are both obtainable, from the play-by-play. See
[`TANK01.md`](TANK01.md) for the full digest, verified across 96 real games.

---

### 🟡 Security review — escrow program

**Decided 2026-08-05:** no commercial audit firm **for the 2026 season**. The owner has a
professional auditor who will review once the tech is mostly built, and audits Solana
programs himself, including bug bounty submissions on other Solana DeFi programs.

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
- **Kani proofs.** Already used on the owner's other Solana programs. Free, and it
  catches the class of bug that drains escrows.
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
**Week 14 (Dec 13)**, the first week that decides a prize.
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
- [ ] **Before the January settlement (~11 Jan 2027, the only payout):** burn it — set the
      upgrade authority to `None`. The program becomes immutable.

That last deadline used to read "before Dec 13 (Week 14, the first payout)". Every prize is
now paid once, after the championship (`docs/RULES.md` §7), so Week 14 moves no money and
that date described nothing. The anchor is unchanged — the last moment before the vault can
be drained — it has simply moved by a month.

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

### ⬜ Settlement oracle address (`SETTLEMENT_ORACLE`, `NEXT_PUBLIC_SETTLEMENT_ORACLE`)

**Blocks:** creating any pot league at all. The route returns 503 without it, in **every**
environment rather than only production — see below.
**Needed by:** **Aug 22**, with the first pot league.

The key permitted to post a league's finalised scores on-chain. Settlement has exactly one
trusted role, because no contract can watch a football game, and this is it — so as of
schemaVersion 8 it is part of the hashed rule set and members sign it before joining.

What it can do is post **scores**. The contract derives the champion, runner-up and best
record from them (`derive.rs`, `bracket.rs`), so no instruction takes a winner; it cannot
change a rule, move a token, or pay anybody, and if it never acts every stake returns at the
refund unlock.

**Refused in every environment, unlike `FEE_RECIPIENT`.** A fee-free league is a real
league, so an unset fee recipient degrades gracefully. There is no graceful version of this:
a pot nobody may post scores for can never be settled, its members wait out the timelock for
money they should have won, and the rules are frozen so it can never be corrected. A locally
created league in that state is one somebody eventually tries to settle.

**Use the Squads vault address, not a raw key** — the same one as the fee recipient is fine.
The value is frozen per league and cannot be rotated, so a raw key that is lost or stolen
means every league naming it refunds instead of settling. A vault address derives from the
multisig account, so the signer set behind it can change without the address moving. Verified
against Squads v4's execution model; see `docs/SETTLEMENT.md` §6, which also records the
trap — never authorise posting by reading the `instruction_sysvar`, which under a multisig
returns the Squads program id rather than the authority.

Set both variables together. The browser one feeds the rules preview on the create screen,
and the form compares the hash it previewed against the hash the server froze.

### ⬜ Pin the USDC mint in the program before mainnet

**Blocks:** nothing. The service half shipped, and it is what closes the reachable
attack — this entry is now defence-in-depth rather than the fix.
**Needed by:** **before any mainnet deployment**, and specifically before the upgrade
authority is burned, because after that the constant can never be corrected.

The program requires pot tokens to have **six decimals**, which is what makes
`MAX_BUY_IN_BASE_UNITS = 50_000_000` mean fifty dollars rather than fifty million of
something. That is as tight as a program can be without a price oracle, and it is **not a
proof of value**: nothing stops a six-decimal token worth far more, or far less, than a
dollar.

**What already shipped.** The mint used to arrive in the create request body and go into
the frozen rules unread, so a crafted POST could denominate a league in any six-decimal
token — including one the caller minted and held the **freeze authority** for. That is the
part that had teeth: a frozen vault makes `refund_stake` fail, and `refund_stake` is the
instruction the whole safety case rests on. The service now derives the mint from
`POT_MINTS` per cluster, the way it already derived the fee recipient, which removes the
only write an attacker had into the signed document. Verified live on 2026-08-13:

| cluster      | mint                                           | decimals |
| ------------ | ---------------------------------------------- | -------- |
| mainnet-beta | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | 6        |
| devnet       | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` | 6        |

**What that does not cover, and why the on-chain pin still matters.** The derivation binds
only while this service is the only way leagues are created. `join_league` and `deposit`
are permissionless, so a socially-directed victim depositing into a raw PDA is defended by
the program alone; and the detection layer is one `if` in the anchor route, which a
refactor could weaken. The program's own comment already says it: an off-chain check
"produces good error messages", and the on-chain one "is what actually binds, because it is
the only one an attacker cannot skip by calling the program directly."

**Why it was not done in the same change.** Localnet cannot mint at a fixed mainnet
address, so it needs a build-time constant with a test-only escape — Anchor programs cannot
ask which chain they are running on, so there is no runtime alternative. That costs **61 of
72 test cases** in `programs/rostr-escrow/tests/`, which all obtain their mint from one
helper. Real work, and not work to do in a hurry.

**Get the polarity right.** Put mainnet in the _default_ build and the test mints behind
the feature flag. A build that forgot its flag then refuses every league on devnet —
loud, immediate, one redeploy. The opposite ships a mainnet program that accepts any
six-decimal token and looks perfectly healthy until someone's pot is denominated in a token
its creator prints.

**And pinning USDC does not remove the freeze risk — it renames it.** Both USDC mints carry
a live freeze authority (mainnet's is Circle's, `7dGbd2QZcCKcTndnHcTL8q7SMVXAkp688NTQYwrRCrar`,
confirmed on-chain). So `require!(mint.freeze_authority.is_none())` and pinning USDC are
mutually exclusive: shipping both makes league creation impossible. The trade is a
regulated issuer who freezes on legal order in place of an anonymous commissioner who can
freeze a mint they made this morning — much better, and not nothing. `docs/RULES.md`,
`lib.rs`'s `refund_stake` and the deposit screen all currently promise a refund that
"can never be stuck"; that sentence needs the exception written into it, in the signed rule
set rather than a banner, the same way the unaudited-escrow warning is.

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
