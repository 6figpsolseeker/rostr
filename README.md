# rostr

Open-source fantasy sports on Solana, starting with football. Web app and native app,
targeting the **Solana Seeker dApp Store**.

> **⚠️ NOT AUDITED.** The escrow contract holds real funds and has not been audited.
> Do not use with money you cannot lose until it has been.

---

## What makes it different

Every other fantasy platform asks you to trust an administrator. This one doesn't.

**Rules are immutable.** A league's scoring, roster, payout split, and deadlines are
frozen at creation and shown in full before anyone joins. The rule set is hashed
on-chain and joining is a signed transaction referencing that hash — so consent is
cryptographic, not a checkbox. No commissioner can rewrite scoring in Week 10 because
their team is losing.

**The pot is escrowed.** Optional per league. Everyone deposits the same amount of the
same token; funds unlock only when the season resolves.

**Nobody declares a winner.** The contract holds the bracket, the scores, and the rules,
and derives the champion from the Week 17 result. There is no sign-off step to corrupt.

**Your roster is yours.** Drafted players mint as Token-2022 NFTs held in your wallet.
Trades move through an escrow with a 48-hour league veto window — they can't be
front-run on a marketplace, and they can't be forced through by a commissioner.

---

## Status

Pre-alpha. Specification first, then the testable core, then the chain programs.

|     |                                                         |
| --- | ------------------------------------------------------- |
| ✅  | League rule set — [`docs/RULES.md`](docs/RULES.md)      |
| ✅  | Data model — [`docs/DATA-MODEL.md`](docs/DATA-MODEL.md) |
| ⬜  | Scoring engine                                          |
| ⬜  | Snake draft + bot auto-pick                             |
| ⬜  | Stats provider adapter                                  |
| ⬜  | Anchor programs — pot escrow, roster NFTs, trade escrow |
| ⬜  | Web app                                                 |
| ⬜  | Native app (React Native + Expo, Mobile Wallet Adapter) |

**Target: the 2026 NFL season, kickoff September 9 2026.** Drafts happen in the last two
weeks of August, so the draftable deadline is late August — not September.

---

## Design at a glance

- **Full PPR.** 4pt passing TD, 6pt rushing/receiving TD, 1pt per 25 passing yards,
  1pt per 10 rushing/receiving yards, −2 per interception and lost fumble.
- **12 teams**, minimum 2 humans, bots fill the rest.
- **Snake draft**, fast (90s minimum) or slow (up to 24h per pick).
- **Weeks 1–14** regular season, **15–17** playoffs, championship Week 17.
  Week 18 is excluded — NFL starters rest once seeding is settled.
- **Head-to-head** weekly matchups. Schedule luck is retained deliberately.
- **Rolling waiver priority.** Win a claim, go to the back of the order.
- **Consolation bracket pays out**, so eliminated teams still have something to play for.
  This is the anti-abandonment mechanism — punishment doesn't work on someone already
  guaranteed nothing.

Full detail in [`docs/RULES.md`](docs/RULES.md).

---

## Multi-sport

Football ships first, but the schema does not know what football is. Sports are data —
a registry of stat keys, positions, and lineup slots — never structure or code branches.
Adding a sport should insert rows and write one provider adapter, with no migration and
no change to scoring, drafting, trading, or settlement.

See [`docs/DATA-MODEL.md`](docs/DATA-MODEL.md).

---

## License

MIT
