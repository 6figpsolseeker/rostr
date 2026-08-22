# Answers to the drops' open questions

Every drop since 6 has carried a list headed "still open, and needing you rather
than a developer". **Five questions have been asked and three of them are
settled**, so the list is asking for decisions that already exist.

This file is the reply, and it is written to be pasted into the design session
rather than read as correspondence — the drops come from the same person the
answers go to.

Each answer names what settles it, so none of this has to be taken on trust.

---

## 1. How autopick signs a transaction the manager was not present for

**It does not. Nothing about a pick signs anything.**

A pick is `recordPick` in `packages/db/src/draft.ts`: one Postgres transaction
writing the `draft_picks` row, the `roster_entries` row and the queue cleanup.
The word "transaction" there is a database transaction. Checked in the route as
well — `apps/web/src/app/api/leagues/[id]/draft/pick/route.ts` contains no
signature, no wallet, no instruction, and no import of either.

The question came from the roster-as-NFT design, where each pick would have
minted a Token-2022 NFT and so needed a signer. **That design was abandoned on
2026-08-19** (`6d28c5e`) — nothing has ever minted one and there is no NFT
program in the tree.

### The consequence: draft room state 6 cannot happen

State 6 is "a manager loses the player they chose because a wallet prompt
outlived its blockhash". There is no wallet prompt in a pick, so there is no
blockhash to outlive. **That branch can be deleted from the draft room design**,
along with the session-key / pre-authorisation / delegated-signer decision it
was waiting on.

**What does sign**, and it is worth the design being exact about which five:

| Moment                | Signs                             |
| --------------------- | --------------------------------- |
| Joining a league      | the rules hash, from your wallet  |
| `deposit`             | a token transfer into the vault   |
| `refund_stake`        | the timelock withdrawal           |
| `initialize_league`   | the commissioner anchoring        |
| `start_season`        | the commissioner closing refunds  |

All five are money or consent. None is a pick, a lineup, a waiver claim or a
trade proposal — a **trade vote** does not sign either.

---

## 2. Which hero animation ships

**A.** Decided 2026-08-21.

---

## 3. Kickoff — 9 or 10 September

**The 9th.** The README was right and the reasoning against it was wrong.

The drops argue "9 Sept 2026 is a Wednesday and NFL Week 1 opens Thursday". That
is a general rule about the NFL calendar applied to a season that does not follow
it. From the synced 2026 schedule:

```
20260909_NE@SEA   week 1   Wednesday 9 Sept, 8:20 PM ET
20260910_SF@LAR   week 1   Thursday 10 Sept, 8:35 PM ET
```

The 10th **is** a Week 1 date, so the designs are not absurd — they are naming
the second game. The season opens on the 9th.

Confirmed by the owner on 2026-08-21. **Twelve design files say the 10th and
should say the 9th.**

---

## 4. When a week label flips

**It depends what the label is for, and both answers are already in the code.**
Tuesday genuinely belongs to two weeks at once, so there is no single right
answer — there are two functions because there are two questions.

- **Reporting what happened** — `currentWeek` (`packages/db/src/week.ts`) is the
  week of the most recent kickoff at or before now. On the Tuesday after Week 10
  it answers **10**. So a screen labelling Tuesday as the week just ended is
  correct, and the designs are right to do it.
- **Enforcing a rule** — `transactionWeek` is the week a transaction would
  *execute into*: the first game after the most recent weekly lock. The lock is
  Tuesday 00:00 ET, so from Tuesday morning it answers **11**.

The distinction is not cosmetic. A trade deadline checked against `currentWeek`
would let a trade resolving on the Tuesday after Week 11 execute into Week 12's
rosters while being checked against Week 11 — which is a bug this repo has
already had and fixed.

**For the screens:** label the week just ended when reporting results, and label
the upcoming week wherever a deadline, a waiver run or a trade window is being
described. If one screen has to do both, they are different labels.

---

## 5. Whether escrow release can move a player whose game is in progress

**Yes, it can, and that is deliberate — the lineup lock is what makes it safe.**

`resolveTrade` does not check kickoff and does not refuse. It cannot: the league
already approved the trade and waited out the veto window, and a throw inside the
resolution would leave the trade stuck with no path forward. The two paths that
*can* refuse do — `dropPlayer` and `addFreeAgent` answer `GAME_STARTED`, which is
`RULES.md` §6.

What stops the exploit is the **lineup lock**, which holds however a player
arrived: a slot locks at that player's own kickoff, so a player acquired
mid-game cannot be started in a game already under way. Closing the route and
closing the outcome are different jobs, and this needs the second.

**For the screens:** a trade can execute while games are running, and the
acquired player is simply unstartable until the following week. Do not draw a
"trade blocked, game in progress" state — it does not exist.

---

## Two things the drops should stop carrying

Not questions, but they recur and they are wrong:

1. **The roster-as-NFT copy.** `Rostr Landing.dc.html` still says "Drafted
   players are held in your wallet" in the hero and "mint as Token-2022 NFTs" on
   a card. Both were removed from the app on 2026-08-19 because they were never
   true. See `STATUS.md`.
2. **"614 tests."** It is 1,989 as of 2026-08-21 and will be wrong again next
   week. A claim about test count in marketing copy dates itself; the surrounding
   sentence works without a number.
