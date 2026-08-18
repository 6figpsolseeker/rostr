# Settlement — how a pot pays out without anyone declaring a winner

**Status: design, not built.** G7 (post finalised scores on-chain) and G8 (derive champion
from bracket) are the missing inputs to D6/G9, the payout. Issue #28 tracks the chain.

**Revised 2026-08-17, after three independent reviews of the first draft.** Section 8
records what that draft got wrong, because two of its errors were the kind that look
settled and are not. Read it before treating anything here as decided.

---

## 1. Settlement has two problems, not one

The first is the one everybody talks about: **who won.** `docs/RULES.md` §7 says the
contract derives that from the scores rather than being told it, and `derive.rs` already
implements half of the derivation.

The second is barely mentioned anywhere and is the harder one: **which wallet is that.**

`compute_standings` answers in team indices (`derive.rs:189-195`), and those index a list of
16-byte Postgres UUIDs. Payout has to move SPL tokens to a `Pubkey`. Nothing on-chain
connects the two: `Membership` is `{league, member, deposited, refunded, bump}`
(`lib.rs:691-701`) and `join_league` takes only a rules hash (`lib.rs:400`). Grep the
program for a team field and there is nothing.

**No computation closes that gap.** Team-to-wallet is a Postgres fact, so somebody attests
it on-chain or settlement cannot complete. Every design here therefore contains an
attestation; they differ only in **when it is made and who can check it before money
moves.**

That reframing is the whole of §2, and it is what the first draft missed.

---

## 2. The payee roster

**Decided: option B below.** One attestation, made before the season, constrained by the
program, and checkable by every member for four months.

### The account

The `Scores` PDA (§4) opens with a fixed roster of `(team_id, wallet)` pairs, written once
at creation, before any game is posted. Never edited afterwards.

**Both halves are needed and neither is redundant.** `LOWEST_TEAM_ID` is the final link in
the default tiebreaker chain (`packages/core/src/rules/nfl-ppr.ts:146`), so team UUIDs feed
the derivation itself — substituting wallets would reorder tied teams and break the corpus.
The wallet is what payout sends to. Two columns, one row per team.

### What the program checks, and what it cannot

At creation, require **every wallet in the roster to hold a funded `Membership` for this
league** — those accounts exist by then and can be passed in. That is a real constraint, not
a formality: the attester **cannot name a wallet that never staked.**

Require also that the roster length equals the league's team count. A pot league may have no
bots (`maxBots` is zero when there is a pot), so every team has a wallet and the roster is
total.

What remains possible is **permutation** — putting the right people in the wrong rows. The
program cannot detect that, and no on-chain check can, because it is precisely the fact the
chain cannot see.

### Why that residual is acceptable

Because a permutation is wrong **months before it is worth anything**, in public, and the
remedy is already built.

The roster is written before the season. Every member can answer "is my wallet next to my
team" from August to January. If it is wrong: **do not call `start_season`.** Every stake
becomes refundable 48 hours after the draft time (`lib.rs:509-511`), with no fee and no
discretion. The league does not play, nobody loses anything, and the attester's error costs
them a season rather than costing members a pot.

Contrast the alternative the first draft implicitly assumed — the roster supplied at payout
time. Same attester, same power, **zero check window**: whoever calls payout names the
destination addresses and the money is gone before anyone can look. The difference between
these two is not who is trusted. It is four months of public scrutiny versus none.

### The options rejected, and why

- **The member binds their own team at `join_league`.** The earliest possible moment and no
  new trusted party, so this was the attractive one. It is broken by `join_league` being
  permissionless (#18, and the `max_teams` comment at `lib.rs:609-632`): team ids are
  visible to league members and on public leagues, so a rival or a stranger claims your team
  id first and the champion's prize pays them. Salvaging it means making joining
  permissioned again, which #18 removed deliberately.
- **Two-party binding — the member signs, the attester countersigns.** Strictly stronger:
  closes the squat above _and_ the permutation in B, because neither party can act alone.
  Costs a transaction per member and makes joining depend on our server being reachable,
  which this project has gone out of its way to avoid (`apps/web/src/lib/escrow.ts:8-16`).
  **The right upgrade on top of B, not the starting point** — and note it is adoptable later
  without a layout change, because it only adds a signature requirement to an instruction
  that does not exist yet.
- **Use on-chain join order as the identity and drop the roster.** Removes the attestation
  entirely, and breaks: strangers can join, so the on-chain order does not match the league,
  and it requires Postgres to defer to the chain about who is in a league — the exact
  inversion #18 concluded the program cannot make.

### The rule that must not be relaxed

**The roster is write-once.** A mutable payee list is the payout-time option wearing a
disguise, and "let me update where my money goes" is the same instruction an attacker wants.
A member who would rather be paid to a different wallet in January is paid to the one they
staked from. That is the honest cost.

---

## 3. What is derived, and from what

Five prize slots exist in the program (`prize` module; `PRIZE_ORDER` in
`packages/escrow/src/instructions.ts` — the two differ from the `PrizeKey` declaration order
and serialising from the wrong one reshuffles the split silently). Both built-in payouts
name three: champion, runner-up, best regular-season record.

- **Best regular-season record** — seed 1 from `compute_standings`, implemented in
  `derive.rs` and pinned to the TypeScript by `standings-corpus.json`.
- **Champion and runner-up** — the Week 17 championship game, which needs the bracket, which
  needs the seeds and the playoff results.

So the on-chain input is the roster plus a list of completed games with scores. Nothing
else. **No standings, no seeds, no bracket, no winner** — every one of those is a
derivation, and posting one instead of the scores is what PR #31 did.

The bracket walk is G8 and is not written. `bracket.ts` is 400 lines with `buildBracket` and
`thirdPlaceWinner`; the corpus pattern from #142 is how it should be pinned.

**Two things `derive.rs` needs that are rules-only today**, and they must be inputs the
attester cannot choose: the tiebreaker chain (its own header says the discriminants "will be
frozen into `League` at creation", `derive.rs:52-54`) and the playoff shape. If they arrive
as instruction arguments the attester picks the tiebreakers and therefore the
best-record prize holder — which is the same defect as posting a standing. **Settle this
while writing G8, not after**, since it is the one part that may genuinely need a `League`
field.

---

## 4. The scores account

A `Scores` PDA per league, seeds `[b"scores", league.key()]`. Not a field on `League`.

Sizing, from `derive.rs`'s limits (`MAX_TEAMS = 16`, `MAX_WEEKS = 18`):

| part                                     | bytes       |
| ---------------------------------------- | ----------- |
| roster — 16 × (16-byte id + 32-byte key) | 768         |
| games — 8 per week × 18 weeks × 11 bytes | 1,584       |
| league, bump, week bitmap, discriminator | ~48         |
| **total**                                | **~2.4 KB** |

Rent-exempt at `(128 + 2400) × 6960` = **0.0176 SOL**, and there is no `close` instruction
anywhere in the program, so it is **not recoverable**. At 1,000 leagues that is ~17 SOL
permanently locked, per season, compounding. `docs/SETUP-REQUIRED.md` currently claims
running cost "holds whether there are ten leagues or ten thousand" — this is the first line
that does not, and that sentence needs correcting when this ships.

**Who may create it is a security question, not a detail.** If the payer or signer is
unconstrained, a stranger front-runs creation, writes a hostile roster, and — with no
`close` — permanently denies settlement to any league whose UUID they can read. That is
#18's shape at the price of rent. Creation must be constrained to the settlement oracle as a
`Signer`, and **must not use `init_if_needed`**: an account with a write-once roster reached
by a re-initialisable instruction is the canonical Anchor re-init bug.

### Weeks are editable until finalised — not write-once

The first draft said write-once per week. That is wrong in a way that only fails at the
worst moment.

Write-once defends against a late correction reopening a settled week, which `RULES.md` §7
genuinely requires. But it also means a week posted early, or posted with one wrong index,
is locked in forever: `compute_records` refuses `UnknownTeam` on any result naming a team
outside the roster (`derive.rs:155`), so a single typo makes the derivation refuse
permanently, and after G10 there is not even an upgrade to fix it. The program holds no
schedule — deliberately, `lib.rs:218-225` — so it cannot tell week 17's real result from
week 17 posted in September.

**So: weeks may be rewritten until an explicit `finalize_week` sets a lock bit, and payout
requires every needed week locked.** Same guarantee, without making a typo terminal.

---

## 5. Where the trust actually sits

**No contract can observe an NFL game, so somebody attests.** `RULES.md` §7 concedes this
already — "stats reach the chain through an oracle" — and `DECISIONS.md` calls it
irreducible. The sentence above it reads as though nobody is trusted at all, and no
achievable design delivers that.

> Settlement introduces exactly one trusted role: whoever posts the roster and the scores.
> No program design removes it. What the design can do is bound what that role achieves and
> widen the window in which anyone can check it.

Bounded, that role:

- posts **scores and a roster**, never a winner, a standing or a seed;
- cannot name a payee who never staked (§2);
- cannot change any frozen term — no instruction mutates a `League`, and it must stay so;
- cannot move a token directly;
- and **if it never acts, every stake returns at `refund_unlock_at`.**

**Be precise about what that last line does and does not cover.** It bounds the _absent_
oracle completely: vanish, lose the key, refuse to act, and members are delayed, not robbed.
It bounds the _dishonest_ oracle not at all, because a dishonest oracle acts before the
timelock opens. Deriving rather than declaring converts "post a winner" into "post the
scores that produce that winner" — the same authority, with a public paper trail attached.

### The seven-day hold — decided 2026-08-17

The paper trail is worth something only if somebody reads it in time. **Payout is illegal
until seven days after the last week it needs has been finalised.**

`Scores` records the instant the final week locked; payout requires `now >= that + 7 days`.
One field, one comparison, and it is a condition on the instruction that can only ever
refuse to pay — never on the refund, which could strand money.

**Seven days, in a window 44 days wide** (§7), so it spends a sixth of the slack and leaves
five sixths. The number matches the stat-correction window members already know from
finalisation, which means it needs no new explanation on the rules screen.

**This is the only thing in the design that bounds a dishonest oracle.** Everything else
bounds an _absent_ one: lose the key, refuse to act, vanish, and members are delayed rather
than robbed, because the timelock returns every stake. None of that helps when the key works
and lies, because a dishonest oracle acts long before the timelock opens. Deriving rather
than declaring converts "post a winner" into "post the scores that produce that winner" —
the same authority, with a receipt. A week of daylight between the receipt and the money is
what makes the receipt worth printing.

It is deliberately **not** a veto. Nobody gains the power to stop a payout; the hold expires
on its own and settlement proceeds. What it buys is time for anyone — any member, or us — to
compare the posted scores against the two providers and, if they disagree, to _not_ send the
payout at all and let the timelock refund everyone. That remedy needs no new instruction and
no new authority, which is why it is the one chosen.

Collusion between the oracle and one member remains mitigated only by this hold and the
2-of-2 signature below. There is no abort instruction, and adding one would be a new
authority over money.

---

## 6. The oracle key

### Two signers, because the signed rules already say so

`requiredOracleSources` is a field of the hashed, member-signed rule set
(`packages/core/src/rules/types.ts:323`), defaults to `2`
(`packages/core/src/rules/nfl-ppr.ts:172`), and **validation refuses a pot league below 2**
(`packages/core/src/rules/validate.ts:701`).

The first draft recommended one required signer with a second optional slot. That would have
every pot league signing a document asserting two sources while the program enforced one —
two fields encoding one fact, disagreeing, which is exactly why `botsAllowed` was deleted.

**So it is 2-of-2, or `requiredOracleSources` changes deliberately and `RULES.md` §7 says
so.** Not a slot left empty.

### The key comes from server configuration, never from the creator

The commissioner authors the rule document and pays for `initialize_league`
(`lib.rs:290`), so if the oracle key is simply a term they supply, nothing stops them naming
**their own keypair**. Members sign it, `anchorTermMismatches` passes — it compares the
chain against the document, and the commissioner wrote both — and at settlement they post
the scores that make themselves champion.

The repo already has the pattern: `FEE_RECIPIENT` and the pot mint come from server
configuration and are **never read from a request**, precisely so a client cannot redirect
them. The oracle is a strictly higher-value field — 1% versus 100% — and needs the same
treatment, plus `settlement_oracle != commissioner` enforced in the program.

**Note what this does to the case for a per-league key.** A program constant is immune to
this attack; a per-league term is not, until the above is done. The first draft argued
per-league was better without weighing that.

### Where the key lives, which nothing in this repo currently has an answer for

`apps/web/src/lib/escrow.ts:8-16` — "The server never signs anything… there is deliberately
no keypair here and nowhere to put one." `packages/escrow/src/instructions.ts:8` — "there is
no server-side signer to lose." A settlement oracle contradicts both, and this document must
not pretend otherwise.

Consequences to face rather than discover:

- The only scheduler is Vercel cron, six HTTP functions (`apps/web/vercel.json`). A key in
  that environment is readable by every server function, including every route parsing user
  input.
- `apps/web/src/lib/cron.ts:12-22` justifies its weak guard explicitly: "an unauthorised
  call cannot produce a wrong pick, a wrong score, or an early settlement. **The guard is
  about database load.**" A settle route makes that false, and the guard accepts its secret
  from a query string.
- `docs/SETUP-REQUIRED.md` sets this project's own key standard — "One key covers neither
  [theft nor loss]. Use 2-of-3" — which a single frozen `Pubkey` cannot meet, and which
  hardware signing cannot meet either at ~19 signatures per league per season.

### `settlement_oracle` is a Squads vault address, not a raw key — verified 2026-08-17

**Still one frozen `Pubkey`, no extra field, no schema cost** — but M-of-N sits behind it,
and the signer set is rotatable without touching the frozen value. That is what turns "lost
key means this league can never pay out" into "lost key means re-key the multisig", and it
is the only way this design meets the 2-of-3 standard `SETUP-REQUIRED.md` already sets for
itself.

The previous draft called this unverified and said to check before committing. Checked:

- A Squads v4 vault transaction executes its inner instructions **via CPI with the vault
  PDA's seeds passed to `invoke_signed`**, so the vault signs on behalf of itself and our
  `Signer` constraint sees `is_signer`. A third-party Anchor instruction is fine.
- The vault PDA derives from the multisig account and a vault index, and the multisig's
  _membership_ lives inside that account. **So changing who signs does not change the
  address**, which is precisely the rotation property wanted. Creating a different multisig
  would change it — the guarantee covers membership changes, not starting over.

**And one trap, which decides how the check must be written.** ChainSecurity's writeup on
designing for Squads is explicit: a program that identifies its caller by reading the
`instruction_sysvar` **breaks under a multisig**, because that sysvar sees only top-level
instructions and returns the Squads program id rather than the authority. Their
recommendation is the one this design already takes — compare a stored `Pubkey` against an
account marked as a signer, since "a PDA signature is unforgeable and context-independent…
it doesn't matter how deeply nested the call is or which program sits at the top of the
instruction stack."

So: **never introspect the instruction stack to authorise posting.** A `Signer` account
compared against `settlement_oracle` is CPI-safe, multisig-safe, and the only form that
stays correct if the key is later moved behind a different custody arrangement.

The residual cost is throughput. Roughly 19 signatures per league per season means routine
posting still runs through a hot delegate rather than hardware approvals; the multisig is
what makes that hot key recoverable rather than what replaces it.

Sources: [ChainSecurity, "Designing for
Squads"](https://www.chainsecurity.com/blog/www-chainsecurity-com-blog-designing-for-squads-a-lesson-in-solana-authorization),
[Squads accounts reference](https://docs.squads.so/main/development/reference/accounts),
[Execute Vault
Transaction](https://docs.squads.so/main/development/typescript/instructions/execute-vault-transaction).

### Multi-season

Per-league keys give free rotation at each season boundary — 2027 leagues name a new key,
nothing migrates. That is a real advantage of per-league over a constant, and it comes with
an obligation: **old keys cannot be retired when the season ends.** A 2026 league stays
settleable until it settles or passes `refund_unlock_at`, up to a year after its draft. The
signer is a keyring indexed by each league's on-chain value, not a key. One
`SETTLEMENT_ORACLE_SECRET` environment variable silently orphans every unsettled prior
league at the first rotation, and the failure surfaces months later at the one moment it
cannot be fixed.

---

## 7. Payout

### It must not touch `refund_stake`, and it does not need to

`refund_stake` has three conditions and `CLAUDE.md` is emphatic that each additional one is
a new way for money to become stuck. Settlement adds none. The separation is by **time**:
`earliestRefundUnlock` puts the timelock at the draft plus the season plus the paying
correction window plus sixty days, and settlement runs at Week 17 + 7 days, inside it.

### But there are two refund doors, not one

The first draft said the exclusion holds "if and only if payout refuses once
`now >= refund_unlock_at`". That was true until 2026-08-17. `refund_stake` now opens two
ways (`lib.rs:509-511`):

```rust
let timelock_open = now >= league.refund_unlock_at;
let failed_open = !league.started && now >= league.start_deadline;
```

`start_deadline` is draft + 48h — **months before settlement.** A pot league whose
`start_season` never landed has every stake withdrawable from then on, while a payout would
still be legal in January. So:

**Payout must require `league.started` as well as refusing at `refund_unlock_at`.** One
line, and the first draft would have shipped without it.

### Atomic — decided 2026-08-17, and it cost a promise rather than a field

**One payout, after the championship.** The owner chose this over two payouts; what follows
records why the question arose and what it moved.

PR #31 split fee and prize; a fee-only drain left the vault unable to satisfy the last
member's refund forever, and `payout_prize` zeroed `total_deposited` so a later
`refund_stake` underflowed on `checked_sub`. A resumable multi-instruction payout recreates
that hazard exactly, and the unconditional refund is the guarantee everything else rests on.

So the trade was **two payouts with a way for money to become permanently stuck, or one
payout a month later**, and one payout won.

The cost is a date in `RULES.md` §7, which said the regular-season prize settled in Week 14.
It is now decided in Week 14 and paid in January with the rest. Nothing about the _result_
moves — the best record is still whoever held it after Week 14, on Week 14's final numbers.

**And the field it looked like this would cost turned out not to be involved.**
`payingWeeks: [14, 17]` reads like a payout trigger and is not one: its only use is
`finalizationHours`, the 168-hour correction window. Week 14 stays in the list — it decides
a prize, a finalised week is never rescored, and dropping it to 48 hours would fix 10% of the
pot on numbers still inside the correction window. **The long window follows what a week
decides, not when it pays.** No schema move, no hash move, no rule value changed.

Two knock-ons, both handled: `RulesView` labelled the field "Paying weeks" above the join
control, which would have promised money moving in December; and `SETUP-REQUIRED.md`
anchored the G10 upgrade-authority burn to "before Dec 13, the first payout", a deadline
that no longer described anything. It is now the January settlement — the same event, the
last moment before the vault can be drained, moved by a month.

### What the first analysis got wrong here

It called this a collision with a **signed rule** — `payingWeeks` in the hashed document
against an atomic payout — and said the fix was to change the rule before any league signed
it. Reading the code showed the field is not what it looks like: it triggers no payout, it
only picks the finalisation window, and there was no conflict to resolve in the rule set at
all. What actually needed changing was a sentence in `RULES.md` and a label above the join
control.

Worth recording because the wrong version was the plausible one. A field called
`payingWeeks` sitting next to a payout question reads as the payout trigger, and the whole
argument for changing it followed from not checking.

### Pay the member set, never a fraction of the vault

`join_league` is permissionless and nothing decrements `member_count`, so anyone may open a
`Membership` and deposit into any league they can name. `total_deposited` is therefore not
the pot. Settlement computes `real_members × buy_in`, bounded by
`real_members <= member_count` and `real_members × buy_in <= total_deposited`.

Two gaps in that bound, both real:

- **A squatter's deposit raises the ceiling the check compares against.** A colluding oracle
  can inflate `real_members` up to it; the squatter's later refund then fails against a
  short vault. Self-inflicted for the squatter, but the bound is not a bound on theft.
- **The honest count can exceed the honest vault.** `deposit` is separate from
  `join_league`, and `start_season` checks only `has_pot`, `!started` and the clock
  (`lib.rs:330-341`) — so a league can legitimately start with twelve members and nine
  deposits. `drawDraftOrder` refuses that off-chain (`POT_NOT_FUNDED`), which is a Postgres
  check, not a program one.

**Under option B the roster closes both**, and that is a second reason to prefer it: the
roster is the member set, it is fixed before the season, and every entry is a verified
funded `Membership`. Pay `roster.len() × buy_in` and there is no count to inflate.

What payout writes to `total_deposited` must be stated explicitly and tested against a
surviving `refund_stake`.

---

## 8. What the first draft of this document got wrong

Recorded rather than quietly edited, because two of these were confidently argued.

1. **It never asked who gets paid.** §1's whole argument was about the `League` layout, and
   the binding that actually has to exist is team→wallet — which lives in an account that
   does not exist yet. The urgency was real and pointed at the wrong thing.
2. **It manufactured an Aug 22 deadline.** The layout window closes at the first league
   holding money someone cannot be asked to start over, not on a calendar date, and the
   product is not launched. Checked: two anchored leagues, both DISSOLVED, and zero rows in
   `league_onchain_stakes`.
3. **Its safety argument was incomplete** — one refund door, not two. §7 above.
4. **It recommended a shape the signed rules forbid** — one required oracle signer against
   `requiredOracleSources: 2`.
5. **It argued per-league beats a constant without weighing the attack per-league
   introduces** — a commissioner naming their own key. §6.
6. **It made write-once-per-week a virtue** when it is a one-way ratchet that turns a typo
   into a permanently unsettleable pot. §4.
7. **It said "cannot post after the timelock opens, because payout is illegal by then"** —
   false. Posting and payout are separate instructions and nothing clocks posting.
8. **It never named where a private key lives**, in a repo that states three times that no
   key of ours exists anywhere.

---

## 8a. Nothing needs to go on `League` — resolved 2026-08-17, after G8

Decision 3 below was "the tiebreaker chain and playoff shape: arguments or `League` fields,
and settle it while writing G8". G8 is written, so this is settled.

**The frozen inputs are exactly four**, and they are small: the tiebreaker chain (which
`compute_standings` takes), the playoff week window, the first-round bye count, and whether
third place is played. Everything else `build_bracket` needs is derived.

They cannot be instruction arguments — an attester choosing the tiebreaker chain chooses the
best-record prize holder, which is the same defect as posting a standing. So they have to be
frozen somewhere. **That somewhere is the `Scores` account, not `League`**, and what makes
it work is an ordering that already exists:

1. The field locks at `scheduledAt` (migration `0028`), so the roster becomes knowable.
2. `Scores` is created, carrying the roster and those four parameters. Write-once.
3. `start_season` is called — and **can require the `Scores` account to exist**, which is a
   check the program can make: the account is there and names this league.
4. The order is drawn.

Step 4 is the enforcement, and it is the piece that makes this as strong as the anchor
check rather than weaker. `drawDraftOrder` already refuses until the chain says `started`;
it can equally refuse until the `Scores` account **agrees with the signed rule set**, in
exactly the shape `anchorTermMismatches` uses for `League`. And a league that never draws
never plays — no draft, no roster, no schedule, nothing to score — so this is not a
courtesy. It is the gate.

**The oracle key rides along.** It goes in the hashed rules and into `Scores`, checked by
the same comparison, which removes the last candidate for a `League` field. The
commissioner-as-oracle attack in §6 is closed the same way every other hostile term is: the
draw refuses a `Scores` account whose terms disagree with the document members signed.

**So the `League` layout is closed**, and with it the last thing in this document that had
an irreversibility argument. What remains is ordinary work. The residual risk moves from
"we cannot change this later" to "somebody must run the comparison" — which is code in the
draw route, not a decision.

Two consequences worth stating rather than discovering:

- **`Scores` must be created before `start_season`**, which is a narrow and well-defined
  window: after the field locks, before the draft. Both instants already exist and are
  already enforced.
- **The oracle key entering the hashed rules still moves the golden hash** (schemaVersion
  6 → 7). That remains free while every anchored league is disposable — §1 — and it is now
  the only schema move settlement needs.

## 9. Open decisions

1. ~~**`payingWeeks`**~~ — **resolved 2026-08-17: one payout, after the championship.** The
   owner's call. It cost a date in `RULES.md` §7 and no rule value, no schema move and no
   hash move — see §7. Nothing here now has a window that closes.
2. ~~**Squads vault as `settlement_oracle`**~~ — **resolved 2026-08-17: yes, verified.** A
   vault transaction signs inner instructions with the vault PDA via `invoke_signed`, and
   membership changes do not move the address. One trap came with it: never authorise
   posting by reading the `instruction_sysvar`, which under a multisig returns the Squads
   program id. (§6)
3. ~~**The tiebreaker chain and playoff shape on-chain**~~ — **resolved**, see §8a. They
   live in `Scores`, verified against the signed rules by the draw. No `League` field.
4. ~~**A mandatory hold before payout**~~ — **resolved 2026-08-17: seven days** after the
   last needed week finalises. One field on `Scores`, one comparison, a condition on payout
   and never on the refund. It is the only thing in this design that bounds a _dishonest_
   oracle rather than an absent one. (§5)

**Nothing is open.** Everything above is now a decision taken, and what remains is
implementation — G7, then payout, then the adversarial suite. If a new decision appears it
belongs here with a date and the reason, like these four.

## 10. Order of work

1. ~~**G8's pure kernel**~~ — **done.** `programs/rostr-escrow/src/bracket.rs`, pinned by
   `bracket-corpus.json`, sixteen cases, mutation-checked. It also answered decision 3 —
   see §8a.
2. ~~**`max_teams` bound**~~ — **done.** `MAX_TEAMS_PER_LEAGUE` is twelve in `@rostr/core`
   and mirrored in the program, checked at creation in both. A twenty-team pot league was
   creatable, anchorable, and unsettleable.
3. **G7** — the `Scores` PDA, the roster, and posting. Under §2, §4, §6 and §8a. The
   account carries the roster **and** the four frozen parameters; the draw verifies both
   against the signed rules.
4. **D6/G9** — payout, under §7.
5. **D8** — the adversarial suite, which does not exist.
6. **D9/G10** — multisig, then burn. Note `BUILD-PLAN.md` currently orders the burn _before_
   the adversarial suite that tests what is being frozen, and lists D9 (multisig) and G10
   (burn) as two end states for the same authority without saying they are a sequence.

## 11. Claims elsewhere that are already false

This document is measured against docs that do not currently describe the code. Fixing
these is part of shipping settlement, not separate from it.

- **`RULES.md`** — "Two independent providers must agree before a week's scores finalise;
  disagreement freezes that week for review." G4 and G5 are unbuilt.
  `requiredOracleSources` is read only by `validate.ts:701` at creation and rendered in
  `RulesView`; nothing in ingest or finalisation consults it. Every member has signed this.
- **`RULES.md`** — "Both oracle providers disagree → the week freezes pending review." Same
  cause.
- **`CLAUDE.md`** — the escrow section still says `League` has "no authority field". False
  since #170 added `commissioner`; the Rust corrected itself and `CLAUDE.md` did not.
- **`packages/core/src/rules/rules.test.ts`** — "No leagues existed on any of these
  occasions" in the schemaVersion changelog. False for 5→6: that rename silently zeroed a
  stat for four leagues in the deployed database.
- **`packages/core/src/rules/types.ts`** — the schemaVersion changelog stops at 3→4 and is
  missing 4→5 and 5→6.
- **`docs/SETUP-REQUIRED.md`** — running cost "holds whether there are ten leagues or ten
  thousand". The `Scores` rent is per-league and unrecoverable. (§4)

There is also **no alerting anywhere in the cron layer**. Settlement is the one job that
fires once per league per year against a hard expiry, so a silent failure has no next run to
correct it and no user complaint to surface it — the app will show a derived champion
regardless.
