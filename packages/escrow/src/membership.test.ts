import { describe, expect, it } from "vitest";
import type { Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { verifyOnChainDeposit, verifyOnChainRefund } from "./verify.js";
import type { RostrEscrow } from "./types.js";

/**
 * What the `Membership` account means, pinned against what the program does.
 *
 * `refund_stake` (`programs/rostr-escrow/src/lib.rs`) sets `refunded = true` and
 * **leaves `deposited` alone** — its own comment says so: "`deposited` is left
 * as the historical record; `refunded` is what gates a second withdrawal."
 *
 * So the four reachable states are:
 *
 * | deposited | refunded | means                                  |
 * | --------- | -------- | -------------------------------------- |
 * | 0         | false    | joined, has not staked                 |
 * | > 0       | false    | staked, money is in the vault          |
 * | > 0       | true     | staked and withdrawn after the timelock|
 * | 0         | true     | unreachable — refund requires amount>0 |
 *
 * Reading `deposited > 0` as "currently staked" is the trap, and it is the one
 * both verifiers fell into. These tests exist because no test in this repo can
 * reach a real `Membership` without a validator, so the *meaning* of the fields
 * has to be pinned somewhere that runs everywhere.
 */

const LEAGUE_ID = "8f14e45f-ceea-467a-9a3c-8e6b7c1f2a3d";
const MEMBER = new PublicKey("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin");

/** A program whose one `Membership` account is whatever this returns. */
function withMembership(
  account: { deposited: bigint; refunded: boolean } | null,
): Program<RostrEscrow> {
  return {
    account: {
      membership: {
        fetchNullable: () =>
          Promise.resolve(
            account === null
              ? null
              : {
                  league: PublicKey.default,
                  member: MEMBER,
                  deposited: { toString: () => account.deposited.toString() },
                  refunded: account.refunded,
                  bump: 255,
                },
          ),
      },
    },
  } as unknown as Program<RostrEscrow>;
}

const verifyDeposit = (a: { deposited: bigint; refunded: boolean } | null) =>
  verifyOnChainDeposit(withMembership(a), LEAGUE_ID, MEMBER);

const verifyRefund = (a: { deposited: bigint; refunded: boolean } | null) =>
  verifyOnChainRefund(withMembership(a), LEAGUE_ID, MEMBER);

describe("verifyOnChainDeposit", () => {
  it("accepts a member whose stake is in the vault", async () => {
    await expect(verifyDeposit({ deposited: 5_000_000n, refunded: false })).resolves.toEqual({
      ok: true,
      deposited: 5_000_000n,
    });
  });

  it("refuses a wallet that has not joined on-chain", async () => {
    // No `Membership` account at all. This is also what makes the whole deposit
    // path inert until on-chain join ships: nothing can be recorded because the
    // account the program requires does not exist.
    await expect(verifyDeposit(null)).resolves.toEqual({ ok: false, reason: "NOT_JOINED" });
  });

  it("tells a member who has not staked that they have not staked", async () => {
    // `deposited === 0` means the money is NOT in. Reporting that as
    // "already deposited" tells someone their buy-in is paid when it is not,
    // which is the one thing a money screen must never do.
    await expect(verifyDeposit({ deposited: 0n, refunded: false })).resolves.toEqual({
      ok: false,
      reason: "NOT_DEPOSITED",
    });
  });

  it("refuses a member who has already withdrawn", async () => {
    // The trap. `deposited` survives a refund as history, so a stake that has
    // been taken back out still reads `deposited > 0` — and would be recorded
    // as a live deposit for money that is no longer in the vault.
    await expect(verifyDeposit({ deposited: 5_000_000n, refunded: true })).resolves.toEqual({
      ok: false,
      reason: "ALREADY_REFUNDED",
    });
  });
});

describe("verifyOnChainRefund", () => {
  it("accepts a completed refund", async () => {
    // The state a genuine refund actually leaves behind: `refunded` set,
    // `deposited` untouched. This is the whole bug — it was the one state the
    // verifier rejected, so no real refund could ever be recorded.
    await expect(verifyRefund({ deposited: 5_000_000n, refunded: true })).resolves.toEqual({
      ok: true,
      refunded: 5_000_000n,
    });
  });

  it("refuses a member who is still staked", async () => {
    // The mirror of the bug: this state used to return `ok`. Composed with the
    // wallet address coming from the request body, any signed-in account could
    // mark any staked member as refunded while their money sat in the vault.
    await expect(verifyRefund({ deposited: 5_000_000n, refunded: false })).resolves.toEqual({
      ok: false,
      reason: "NOT_REFUNDED",
    });
  });

  it("refuses a wallet that has not joined on-chain", async () => {
    await expect(verifyRefund(null)).resolves.toEqual({ ok: false, reason: "NOT_JOINED" });
  });

  it("refuses a member who never staked", async () => {
    await expect(verifyRefund({ deposited: 0n, refunded: false })).resolves.toEqual({
      ok: false,
      reason: "NOTHING_DEPOSITED",
    });
  });
});
