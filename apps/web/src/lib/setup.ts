/**
 * What the commissioner still owes their own league.
 *
 * `createLeague` seats nobody (issue #165). Creating a league writes `leagues`,
 * `league_rules` and `drafts` and stops there — no team, no membership — because
 * joining is a wallet signature over the rules hash and a league is unanchored at
 * the instant it is created, so `joinLeague` would refuse it. The commissioner is
 * therefore a stranger to their own league until they walk the same four steps
 * every other member walks, and until 2026-08-16 nothing on any screen said so.
 *
 * Pure, and deliberately so. `apps/web` cannot render a component in a test —
 * both vitest projects are node-environment with no jsdom — so what the screen
 * decides has to live where a test can reach it. `lib/lobby.ts` and `lib/pot.ts`
 * are the pattern.
 *
 * **This is a checklist, not a wizard.** Every input is resolved server-side from
 * rows that already exist, so the position survives a reload, a new tab, and the
 * wallet popup in the middle of steps 1 and 4 — which is not an exceptional case
 * here, it is the ordinary one. A wizard holding its position in `useState` would
 * strand a commissioner at exactly the moment a popup stole focus, which is the
 * failure `JoinPanel`'s `resumable` already exists to prevent.
 */

/** The four steps, in the order the screen offers them. See `SETUP_ORDER`. */
export type SetupStepKey = "ANCHOR" | "LINK" | "SEAT" | "ONCHAIN";

/** The next step, or `DONE` when the commissioner is fully seated. */
export type SetupStep = SetupStepKey | "DONE";

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
  /** At least one wallet proven by signature — `wallets`, not a typed address. */
  readonly hasLinkedWallet: boolean;
  /** The rules are on-chain. `joinLeague` refuses until they are. */
  readonly anchored: boolean;
  /** A `league_memberships` row, and so a team. Signed the rules hash. */
  readonly hasTeam: boolean;
  /** The `Membership` PDA exists and is recorded in `league_onchain_joins`. */
  readonly onChainJoined: boolean;
}

export interface SetupItem {
  readonly key: SetupStepKey;
  /** Already satisfied — independently of position, so a checklist is honest. */
  readonly done: boolean;
  /** The one step to act on now. Exactly one item carries it, until `complete`. */
  readonly current: boolean;
}

export interface CommissionerSetupView {
  readonly step: SetupStep;
  readonly items: readonly SetupItem[];
  /** How many of the four are still owed. */
  readonly remaining: number;
  /** Nothing left. The caller renders nothing rather than an all-ticked list. */
  readonly complete: boolean;
}

/**
 * The next step the commissioner owes, or `null` if they are not the
 * commissioner.
 *
 * Steps are checked in `SETUP_ORDER` and the first unsatisfied one wins. The
 * states are nested by construction rather than by this function's say-so —
 * `joinLeague` requires a linked wallet and an anchored league, and
 * `/join-onchain` derives its wallet from the membership row — so the only pair
 * that can legitimately complete out of order is anchoring before linking. That
 * one can: anchoring signs a transaction from a connected wallet and never
 * consults `wallets`.
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
 * The whole checklist, or `null` for anyone who is not the commissioner.
 *
 * `done` is each step's own condition and not "comes before the current one", so
 * a commissioner who anchored before linking sees an anchored league ticked
 * rather than a list claiming they have not done the thing they just did.
 */
export function commissionerSetup(input: CommissionerSetupInput): CommissionerSetupView | null {
  const step = commissionerSetupStep(input);
  if (step === null) return null;

  const items = SETUP_ORDER.map((key): SetupItem => ({
    key,
    done: satisfied(input, key),
    current: key === step,
  }));

  return {
    step,
    items,
    remaining: items.filter((item) => !item.done).length,
    complete: step === "DONE",
  };
}
