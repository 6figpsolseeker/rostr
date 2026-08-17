/**
 * What the commissioner still owes their own league.
 *
 * `createLeague` seats nobody (issue #165). Creating a league writes the rules —
 * `leagues`, `league_rules` and their two denormalised copies — and the route
 * then schedules the draft in a second transaction. **No team, no membership**,
 * because joining is a wallet signature over the rules hash and a league is
 * unanchored at the instant it is created, so `joinLeague` would refuse it. The
 * commissioner is therefore a stranger to their own league until they walk the
 * same four steps every other member walks, and until 2026-08-17 nothing on any
 * screen said so.
 *
 * Pure, and deliberately so. `apps/web` cannot render a component in a test —
 * both vitest projects are node-environment with no jsdom — so what the screen
 * decides has to live where a test can reach it. `lib/lobby.ts` and `lib/pot.ts`
 * are the pattern.
 *
 * **This is a checklist, not a wizard.** Every input is resolved server-side from
 * rows that already exist, so the position survives a reload, a new tab, and the
 * wallet popup in the middle of any of the four — every step signs something, two
 * transactions and two messages, so leaving the page part-way through is the
 * ordinary case here rather than the exceptional one. A wizard holding its
 * position in `useState` would strand a commissioner at exactly the moment a
 * popup stole focus, which is the failure `JoinPanel`'s `resumable` already
 * exists to prevent.
 *
 * **And a checklist has to know when it has run out of time.** Three of the four
 * steps are only reachable while the league still accepts members, and nothing
 * in this app moves a league out of `FORMING` when its draft time passes — so
 * without `blocker` below, this would go on naming "take your seat" as the next
 * action on a full league, a dissolved one, and one whose field migration `0028`
 * locked permanently. That is the state #165 exists to warn about, and a panel
 * that reported it as an ordinary to-do would be the loudest possible way to get
 * it wrong.
 */

/** The four steps, in the order the screen offers them. See `SETUP_ORDER`. */
export type SetupStepKey = "ANCHOR" | "LINK" | "SEAT" | "ONCHAIN";

/** The next step in the bare sequence, or `DONE`. See `commissionerSetupStep`. */
export type SetupStep = SetupStepKey | "DONE";

/**
 * Why the outstanding steps can never be completed. `null` while they can.
 *
 * The codes and their order mirror `joinLeague`'s own refusals — state first,
 * then `requireOpenField`, then the seat count checked inside its transaction —
 * so the screen and the server cannot disagree about which reason comes first.
 * Same shape and same reasoning as `DrawBlocker` in `lib/lobby.ts`.
 */
export type SetupBlocker =
  | { readonly code: "LEAGUE_CLOSED"; readonly state: string }
  | { readonly code: "FIELD_LOCKED" }
  | { readonly code: "LEAGUE_FULL" };

/**
 * Anchor first, and this is **not** the order the issue's plan tabulates.
 *
 * That table lists linking the wallet as step 1 because it is the first wallet
 * interaction in an uninterrupted run. But linking is reachable only from
 * `JoinPanel`, and `JoinPanel` renders its "not open yet" notice — with no link
 * control at all — until the league is anchored. So a checklist that pointed at
 * LINK first would name a step that has no button anywhere on the page.
 *
 * Anchoring is also the only step that blocks *other people*: nobody can join an
 * unanchored league, so a commissioner who stalls there has a league nobody else
 * can enter either. Extracting the link control so it stands on its own is the
 * next piece of #165, and when it lands this order is worth revisiting.
 */
export const SETUP_ORDER = ["ANCHOR", "LINK", "SEAT", "ONCHAIN"] as const;

export interface CommissionerSetupInput {
  /** Whether this viewer created the league. Nothing renders for anyone else. */
  readonly isCommissioner: boolean;
  /**
   * This **user** has at least one wallet proven by signature — a `wallets` row,
   * never a typed address.
   *
   * Per-user rather than per-league, and per-user rather than per-*connected
   * wallet*, which is the one place this checklist is coarser than the control
   * it points at: `JoinPanel` gates on whether the currently connected address
   * is linked (`linked.includes(address)`), so a commissioner holding a wallet
   * linked from an earlier league, who then connects a second one, sees LINK
   * ticked and is still asked to verify. The tick is true at the level it
   * claims — they have linked a wallet — and the panel below asks for what it
   * actually needs. Narrowing it would mean knowing the connected address,
   * which only the browser has, and this file is resolved on the server.
   */
  readonly hasLinkedWallet: boolean;
  /** The rules are on-chain. `joinLeague` refuses until they are. */
  readonly anchored: boolean;
  /** A `league_memberships` row, and so a team. Signed the rules hash. */
  readonly hasTeam: boolean;
  /** The `Membership` PDA exists and is recorded in `league_onchain_joins`. */
  readonly onChainJoined: boolean;
  /** `leagues.state`. Only `FORMING` accepts members. */
  readonly leagueState: string;
  /** `taken < maxTeams`. */
  readonly seatsFree: boolean;
  /**
   * The frozen draft time has passed, so migration `0028` refuses every further
   * `teams` INSERT. Computed by the caller against the server's clock.
   */
  readonly fieldLocked: boolean;
}

export interface SetupItem {
  readonly key: SetupStepKey;
  /** Already satisfied — independently of position, so a checklist is honest. */
  readonly done: boolean;
  /** The one step to act on now. Nothing is current when `blocker` is set. */
  readonly current: boolean;
}

export interface CommissionerSetupView {
  /**
   * The step to act on now, or `null` when nothing is: either `complete`, or
   * `blocker` says the rest can never be done.
   */
  readonly next: SetupStepKey | null;
  readonly items: readonly SetupItem[];
  /** How many of the four are still owed. */
  readonly remaining: number;
  /** Nothing left. The caller renders nothing rather than an all-ticked list. */
  readonly complete: boolean;
  /** Set when the outstanding steps are unreachable. See `SetupBlocker`. */
  readonly blocker: SetupBlocker | null;
  /**
   * The commissioner holds a seat, so only the on-chain record can still be
   * owed — and that step needs no open field. Callers use it to avoid telling a
   * seated commissioner they are not in their own league.
   */
  readonly seated: boolean;
}

/**
 * The next step in the bare sequence, or `null` if this is not the commissioner.
 *
 * **Knows nothing about `blocker`**, deliberately: it answers "which step is
 * outstanding", not "which step can be done". On a dissolved or full league it
 * still says `SEAT`, which is the correct answer to the question it is asked and
 * the wrong thing to put on a screen. Screens call `commissionerSetup`.
 *
 * Steps are checked in `SETUP_ORDER` and the first unsatisfied one wins. The
 * states are otherwise nested by construction rather than by this function's
 * say-so — `joinLeague` requires a linked wallet and an anchored league, and
 * `/join-onchain` derives its wallet from the membership row — with exactly one
 * exception: **ANCHOR and LINK are independent in both directions.** Anchoring
 * signs a transaction from the connected wallet and never consults `wallets`, so
 * it can be done first; and `wallets` is per-user, so a commissioner who linked
 * one on any previous league arrives with LINK already satisfied and ANCHOR
 * outstanding. That second case is the ordinary one for a returning user, and it
 * is why `done` below is each step's own condition.
 */
export function commissionerSetupStep(input: CommissionerSetupInput): SetupStep | null {
  if (!input.isCommissioner) return null;
  if (!input.anchored) return "ANCHOR";
  if (!input.hasLinkedWallet) return "LINK";
  if (!input.hasTeam) return "SEAT";
  if (!input.onChainJoined) return "ONCHAIN";
  return "DONE";
}

/** Whether one step's own condition is met, ignoring where it sits in the order. */
function satisfied(input: CommissionerSetupInput, key: SetupStepKey): boolean {
  switch (key) {
    case "ANCHOR":
      return input.anchored;
    case "LINK":
      return input.hasLinkedWallet;
    case "SEAT":
      return input.hasTeam;
    case "ONCHAIN":
      return input.onChainJoined;
  }
}

/**
 * Why the outstanding steps cannot be completed, or `null`.
 *
 * **Only ever set for a commissioner without a seat**, and that exception is the
 * load-bearing half. Once `hasTeam` is true the only step left is the on-chain
 * record, which `/join-onchain` grants against the existing membership row — it
 * consults neither the league's state nor its seat count nor the field lock. So
 * a commissioner who joined and then let the draft start must still be sent to
 * finish it, and a blocker there would strand a member holding a seat with no
 * `Membership` account, which is precisely what `resumable` exists to prevent.
 */
function seatBlocker(input: CommissionerSetupInput): SetupBlocker | null {
  if (input.hasTeam) return null;
  if (input.leagueState !== "FORMING") {
    return { code: "LEAGUE_CLOSED", state: input.leagueState };
  }
  if (input.fieldLocked) return { code: "FIELD_LOCKED" };
  if (!input.seatsFree) return { code: "LEAGUE_FULL" };
  return null;
}

/**
 * The whole checklist, or `null` for anyone who is not the commissioner.
 *
 * `done` is each step's own condition and not "comes before the current one", so
 * a commissioner who anchored before linking — or who arrived with a wallet
 * already linked from another league — sees what they actually did ticked rather
 * than a list contradicting them.
 */
export function commissionerSetup(input: CommissionerSetupInput): CommissionerSetupView | null {
  const step = commissionerSetupStep(input);
  if (step === null) return null;

  const blocker = seatBlocker(input);
  const complete = step === "DONE";
  const next = complete || blocker !== null ? null : step;

  const items = SETUP_ORDER.map((key): SetupItem => ({
    key,
    done: satisfied(input, key),
    current: key === next,
  }));

  return {
    next,
    items,
    remaining: items.filter((item) => !item.done).length,
    complete,
    blocker,
    seated: input.hasTeam,
  };
}
