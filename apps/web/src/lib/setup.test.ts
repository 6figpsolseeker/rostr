import { describe, expect, it } from "vitest";
import {
  commissionerSetup,
  commissionerSetupStep,
  SETUP_ORDER,
  type CommissionerSetupInput,
} from "./setup";

/** A commissioner who has just pressed "Freeze and create the league". */
function fresh(overrides: Partial<CommissionerSetupInput> = {}): CommissionerSetupInput {
  return {
    isCommissioner: true,
    hasLinkedWallet: false,
    anchored: false,
    hasTeam: false,
    onChainJoined: false,
    leagueState: "FORMING",
    seatsFree: true,
    fieldLocked: false,
    ...overrides,
  };
}

/** The state at the end of the flow. */
const seated: CommissionerSetupInput = fresh({
  hasLinkedWallet: true,
  anchored: true,
  hasTeam: true,
  onChainJoined: true,
});

describe("commissionerSetupStep", () => {
  it("is null for anyone who did not create the league", () => {
    expect(commissionerSetupStep(fresh({ isCommissioner: false }))).toBeNull();
    // Including a member who is fully seated: the checklist is the
    // commissioner's own, and `JoinPanel` is what speaks to everybody else.
    expect(commissionerSetupStep({ ...seated, isCommissioner: false })).toBeNull();
  });

  it("walks the four steps in order", () => {
    expect(commissionerSetupStep(fresh())).toBe("ANCHOR");
    expect(commissionerSetupStep(fresh({ anchored: true }))).toBe("LINK");
    expect(commissionerSetupStep(fresh({ anchored: true, hasLinkedWallet: true }))).toBe(
      "SEAT",
    );
    expect(
      commissionerSetupStep(fresh({ anchored: true, hasLinkedWallet: true, hasTeam: true })),
    ).toBe("ONCHAIN");
    expect(commissionerSetupStep(seated)).toBe("DONE");
  });

  /**
   * ANCHOR and LINK are independent in both directions.
   *
   * `AnchorPanel` signs from the connected wallet and never consults `wallets`,
   * so a commissioner can anchor without ever linking; and `wallets` is
   * per-user, so one who linked on a previous league arrives with LINK already
   * satisfied. Every other ordering is enforced upstream — `joinLeague` refuses
   * an unanchored league and an unlinked wallet, and `/join-onchain` derives its
   * wallet from the membership row that step 3 writes.
   */
  it("asks for the link after an anchor signed by an unlinked wallet", () => {
    expect(commissionerSetupStep(fresh({ anchored: true }))).toBe("LINK");
  });

  it("does not skip the anchor for a commissioner who linked a wallet first", () => {
    expect(commissionerSetupStep(fresh({ hasLinkedWallet: true }))).toBe("ANCHOR");
  });

  /**
   * The trap this function is deliberately not protected against.
   *
   * It answers "which step is outstanding", which on a dead league is still
   * `SEAT`. Putting that on a screen is what `commissionerSetup`'s `blocker`
   * exists to stop, and the two answers are asserted side by side here so
   * nobody wires the wrong one into a page.
   */
  it("still names a step on a league that can never be joined", () => {
    const dissolved = fresh({
      anchored: true,
      hasLinkedWallet: true,
      leagueState: "DISSOLVED",
    });

    expect(commissionerSetupStep(dissolved)).toBe("SEAT");
    expect(commissionerSetup(dissolved)!.next).toBeNull();
  });
});

describe("commissionerSetup", () => {
  it("is null for anyone who did not create the league", () => {
    expect(commissionerSetup(fresh({ isCommissioner: false }))).toBeNull();
  });

  it("marks exactly one step current until the last is done", () => {
    for (const input of [
      fresh(),
      fresh({ anchored: true }),
      fresh({ anchored: true, hasLinkedWallet: true }),
      fresh({ anchored: true, hasLinkedWallet: true, hasTeam: true }),
    ]) {
      const view = commissionerSetup(input)!;
      expect(view.items.filter((item) => item.current)).toHaveLength(1);
      expect(view.next).not.toBeNull();
      expect(view.complete).toBe(false);
      expect(view.blocker).toBeNull();
    }
  });

  it("marks nothing current once every step is done", () => {
    const view = commissionerSetup(seated)!;
    expect(view.items.every((item) => item.done)).toBe(true);
    expect(view.items.some((item) => item.current)).toBe(false);
    expect(view.next).toBeNull();
    expect(view.complete).toBe(true);
    expect(view.remaining).toBe(0);
  });

  /**
   * `done` is each step's own condition, not "sits before the current one".
   *
   * A commissioner who anchored with an unlinked wallet must not be shown a list
   * claiming they have not anchored — that is the screen contradicting the thing
   * it is reporting on, and the anchor is the step nobody can repeat.
   */
  it("ticks a step completed out of order", () => {
    const view = commissionerSetup(fresh({ anchored: true }))!;
    const byKey = Object.fromEntries(view.items.map((item) => [item.key, item]));

    expect(byKey["ANCHOR"]).toMatchObject({ done: true, current: false });
    expect(byKey["LINK"]).toMatchObject({ done: false, current: true });
    expect(view.remaining).toBe(3);
  });

  it("counts down as steps land", () => {
    expect(commissionerSetup(fresh())!.remaining).toBe(4);
    expect(commissionerSetup(fresh({ anchored: true }))!.remaining).toBe(3);
    expect(
      commissionerSetup(fresh({ anchored: true, hasLinkedWallet: true, hasTeam: true }))!
        .remaining,
    ).toBe(1);
  });

  it("reports every step, in the screen's order", () => {
    expect(commissionerSetup(fresh())!.items.map((item) => item.key)).toEqual([...SETUP_ORDER]);
  });
});

/**
 * The three states in which the remaining steps can never be taken.
 *
 * Each was a screen that said "Sign the rules and take your seat — next" beside
 * a `JoinPanel` reading "This league is not accepting members". Nothing in this
 * app moves a league out of `FORMING` when its draft time passes, so without
 * these the checklist was monotone forever.
 */
describe("blockers", () => {
  const readyToSeat = { anchored: true, hasLinkedWallet: true };

  it("blocks on a league that has left FORMING", () => {
    for (const state of ["DRAFTING", "IN_SEASON", "PLAYOFFS", "SETTLED", "DISSOLVED"]) {
      const view = commissionerSetup(fresh({ ...readyToSeat, leagueState: state }))!;
      expect(view.blocker).toEqual({ code: "LEAGUE_CLOSED", state });
      expect(view.next).toBeNull();
      expect(view.items.some((item) => item.current)).toBe(false);
    }
  });

  it("blocks once the field has locked", () => {
    const view = commissionerSetup(fresh({ ...readyToSeat, fieldLocked: true }))!;
    expect(view.blocker).toEqual({ code: "FIELD_LOCKED" });
    expect(view.next).toBeNull();
  });

  it("blocks on a full league", () => {
    const view = commissionerSetup(fresh({ ...readyToSeat, seatsFree: false }))!;
    expect(view.blocker).toEqual({ code: "LEAGUE_FULL" });
    expect(view.next).toBeNull();
  });

  /**
   * The order matches `joinLeague`'s own refusals: state, then
   * `requireOpenField`, then the seat count checked inside its transaction. A
   * screen naming a different reason than the server would is the two-sources
   * problem this repo keeps paying for.
   */
  it("reports the reason the server would report first", () => {
    const view = commissionerSetup(
      fresh({ ...readyToSeat, leagueState: "DRAFTING", fieldLocked: true, seatsFree: false }),
    )!;
    expect(view.blocker).toEqual({ code: "LEAGUE_CLOSED", state: "DRAFTING" });
  });

  it("blocks an unanchored league too, rather than inviting a pointless anchor", () => {
    // Nobody can join a locked field, so anchoring would buy nothing — not for
    // the commissioner and not for anyone they invited.
    const view = commissionerSetup(fresh({ leagueState: "DISSOLVED" }))!;
    expect(view.blocker).toEqual({ code: "LEAGUE_CLOSED", state: "DISSOLVED" });
    expect(view.next).toBeNull();
    expect(view.remaining).toBe(4);
  });

  /**
   * The exception, and the reason `seatBlocker` short-circuits on `hasTeam`.
   *
   * `/join-onchain` grants the on-chain record against the existing membership
   * row and consults neither the state, the seat count nor the field lock. A
   * commissioner who joined and then started the draft still owes that step and
   * must still be sent to finish it — blocking here would strand a member
   * holding a seat with no `Membership` account.
   */
  it("never blocks a seated commissioner who still owes the on-chain record", () => {
    for (const overrides of [
      { leagueState: "DRAFTING" },
      { leagueState: "IN_SEASON" },
      { fieldLocked: true },
      { seatsFree: false },
    ]) {
      const view = commissionerSetup(fresh({ ...readyToSeat, hasTeam: true, ...overrides }))!;
      expect(view.blocker).toBeNull();
      expect(view.next).toBe("ONCHAIN");
      expect(view.seated).toBe(true);
    }
  });

  it("never blocks a commissioner who has finished", () => {
    const view = commissionerSetup({ ...seated, leagueState: "IN_SEASON" })!;
    expect(view.blocker).toBeNull();
    expect(view.complete).toBe(true);
  });

  it("reports whether a seat is held, so the copy can stop saying nobody joined", () => {
    expect(commissionerSetup(fresh())!.seated).toBe(false);
    expect(commissionerSetup(fresh({ ...readyToSeat, hasTeam: true }))!.seated).toBe(true);
  });
});
