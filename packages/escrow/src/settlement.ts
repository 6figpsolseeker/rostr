/**
 * Whether the program can pay a pot out, and therefore whether this app should
 * invite a buy-in.
 *
 * ## Why this exists
 *
 * "Pot leagues cannot take money yet" used to be true **structurally**: the
 * program's `deposit` requires a `Membership` account, only `join_league`
 * creates one, and the app did not invoke `join_league`. So no client could
 * deposit, because the account a deposit needs did not exist. Nobody had to
 * remember anything.
 *
 * On-chain join has since shipped, and that property is gone with it. What
 * replaces it has to be something nobody can forget to set, because the thing it
 * guards is a member's money.
 *
 * ## The rule
 *
 * A mainnet deposit is open only once the program has an instruction that can
 * pay it back out. Until then the sole exit from a vault is `refund_stake` after
 * the timelock, so a buy-in is a payment for prizes nobody can award.
 *
 * The **committed IDL** is what answers that. It is the program's interface, it
 * is in the tree, and `pnpm idl:check` fails in the Anchor job when it drifts
 * from the Rust. So the day settlement ships, `pnpm idl:sync` regenerates this
 * file's input and the gate opens **in the same commit** — not on a date, not on
 * an environment variable somebody has to unset.
 *
 * ## What this is not
 *
 * This is a client-side rule and it must not be mistaken for the structural
 * guarantee it replaces. `deposit` is permissionless on-chain (`lib.rs`): any
 * member who has joined can build the instruction and send it themselves, and
 * nothing in TypeScript can stop them. This decides what **our** clients invite,
 * which is the strongest form available without changing Rust — and Rust is
 * deliberately not on the table, because `refund_stake` having exactly three
 * conditions is what makes the escape hatch trustworthy.
 */

import { ESCROW_IDL } from "./idl.js";
import type { Cluster } from "./cluster.js";

/**
 * Instruction-name prefixes that would mean "this program can pay a pot out".
 *
 * A guess about what D6 will be called, and it does not have to be right: the
 * tripwire in `settlement.test.ts` pins the current instruction list, so the
 * commit that adds settlement is forced to open this file whatever it names its
 * instruction.
 */
export const SETTLEMENT_PREFIXES = ["settle", "payout", "distribute"] as const;

/**
 * The IDL, seen as loosely as possible.
 *
 * `EscrowIdl` types `instructions` as `readonly unknown[]`, so this narrows each
 * element at runtime instead of casting. That is the right direction anyway: a
 * regenerated IDL whose shape has moved should read as "no settlement here" and
 * keep the gate shut, not throw on a page a stranger can load.
 */
export interface IdlShape {
  readonly instructions: readonly unknown[];
}

/** The instruction names an IDL declares, ignoring anything malformed. */
export function instructionNames(idl: IdlShape = ESCROW_IDL): string[] {
  return idl.instructions
    .map((instruction) =>
      typeof instruction === "object" &&
      instruction !== null &&
      "name" in instruction &&
      typeof instruction.name === "string"
        ? instruction.name
        : null,
    )
    .filter((name): name is string => name !== null);
}

/** Does this IDL describe a program that can move a pot to its winners? */
export function settlementShipped(idl: IdlShape = ESCROW_IDL): boolean {
  return instructionNames(idl).some((name) =>
    SETTLEMENT_PREFIXES.some((prefix) => name.startsWith(prefix)),
  );
}

export type DepositGate =
  { readonly open: true } | { readonly open: false; readonly reason: "SETTLEMENT_NOT_SHIPPED" };

/**
 * Whether this deployment should invite a pot deposit.
 *
 * Open everywhere except mainnet while settlement is missing. Devnet, testnet
 * and localnet stay open on purpose: the funding path has to be exercisable end
 * to end — that is the Aug 22 milestone, and it is what `stake.test.ts` proves
 * against a real validator — and no real money is at risk on those chains.
 *
 * Closed on mainnet, where a stake would be real and the only way back out is a
 * timelock the league's own creator sets months away.
 */
export function potDepositGate(cluster: Cluster, idl: IdlShape = ESCROW_IDL): DepositGate {
  if (settlementShipped(idl)) return { open: true };
  if (cluster !== "mainnet-beta") return { open: true };
  return { open: false, reason: "SETTLEMENT_NOT_SHIPPED" };
}
