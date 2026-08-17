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
    ...overrides,
  };
}

/** The state at the end of the flow. */
const seated: CommissionerSetupInput = {
  isCommissioner: true,
  hasLinkedWallet: true,
  anchored: true,
  hasTeam: true,
  onChainJoined: true,
};

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
   * The one pair that can legitimately complete out of order.
   *
   * `AnchorPanel` signs a transaction from the connected wallet and never
   * consults `wallets`, so a commissioner can anchor without ever linking. Every
   * other ordering is enforced upstream — `joinLeague` refuses an unanchored
   * league and an unlinked wallet, and `/join-onchain` derives its wallet from
   * the membership row that step 3 writes.
   */
  it("asks for the link after an anchor signed by an unlinked wallet", () => {
    expect(commissionerSetupStep(fresh({ anchored: true }))).toBe("LINK");
  });

  it("does not skip the anchor for a commissioner who linked a wallet first", () => {
    expect(commissionerSetupStep(fresh({ hasLinkedWallet: true }))).toBe("ANCHOR");
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
      expect(view.complete).toBe(false);
    }
  });

  it("marks nothing current once every step is done", () => {
    const view = commissionerSetup(seated)!;
    expect(view.items.every((item) => item.done)).toBe(true);
    expect(view.items.some((item) => item.current)).toBe(false);
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
