import { describe, expect, it } from "vitest";

import type { PrizeKey as RulesPrizeKey } from "@rostr/core";
import {
  ESCROW_IDL,
  PRIZE_ORDER,
  type EscrowIdl,
  type PrizeKey as WirePrizeKey,
} from "@rostr/escrow";

/**
 * The prize enum is declared three times, in three languages, and nothing links them.
 *
 * `PrizeKey` in `packages/core/src/rules/types.ts` is the signed rule set's vocabulary.
 * `PRIZE_ORDER` in `packages/escrow/src/instructions.ts` is the wire order. `PRIZE_COUNT`
 * and the `prize::` indices in `programs/rostr-escrow/src/lib.rs` are the account layout.
 * The first two deliberately disagree on *order* — both files say so — so they cannot
 * simply be the same list, and the escrow package deliberately does not depend on
 * `@rostr/core` (`RulesLikeTerms` is structural for exactly that reason).
 *
 * The cost of that decoupling is that drift is silent. `payoutArray` matches shares by
 * name with `shares.find(...)` and returns `?? 0` for anything it does not recognise, so
 * a prize renamed in the rule schema does not fail to compile and does not throw — it
 * becomes a zero in `payout_bps`, the on-chain array that decides who gets paid. A prize
 * *added* to the schema is worse: `PRIZE_COUNT: usize = 5` is in the Rust account layout.
 *
 * This file is the link. It lives in `apps/web` because that is the only place both
 * packages are legitimately dependencies — it is where the anchor route maps one to the
 * other — and, more importantly, because it is the only place a type-level assertion is
 * actually checked: `packages/core` and `packages/escrow` both exclude `src/**\/*.test.ts`
 * from their tsconfig, so a compile-time guard written next to `PRIZE_ORDER` would never
 * run. `apps/web/tsconfig.json` includes `**\/*.ts`, so the block below is checked by
 * `pnpm typecheck`.
 */

/**
 * `[A] extends [B]` in tuples, not bare: a bare conditional distributes over a union and
 * would answer "does every member extend B" one member at a time, which is true for the
 * empty case and quietly weakens the assertion.
 */
type Covers<A, B> = [A] extends [B] ? true : false;

/**
 * These two lines are the guard. They are assignments, not tests — if the rule schema
 * gains, loses or renames a prize and `PRIZE_ORDER` does not follow, one of them stops
 * being `true` and `pnpm typecheck` fails on this file.
 */
const wireCoversRules: Covers<RulesPrizeKey, WirePrizeKey> = true;
const rulesCoverWire: Covers<WirePrizeKey, RulesPrizeKey> = true;

/**
 * Every `payout_bps` array length the IDL declares.
 *
 * Walked defensively rather than indexed, in the manner of `instructionNames` in
 * `settlement.ts`: `EscrowIdl["types"]` is `readonly unknown[]` on purpose, and the field
 * appears in more than one struct (the `League` account and the initialise args). All of
 * them have to agree with the client, so all of them are collected.
 */
function payoutBpsLengths(idl: EscrowIdl): number[] {
  const found: number[] = [];

  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (typeof node !== "object" || node === null) return;

    const record = node as Record<string, unknown>;

    // Both spellings. The committed IDL is snake_case today; an Anchor release that
    // changed it should fail the "declares it at all" assertion below, not silently
    // find nothing and pass.
    if (record["name"] === "payout_bps" || record["name"] === "payoutBps") {
      const type = record["type"];
      if (typeof type === "object" && type !== null && "array" in type) {
        const shape = (type as { readonly array: unknown }).array;
        if (Array.isArray(shape) && typeof shape[1] === "number") found.push(shape[1]);
      }
    }

    for (const value of Object.values(record)) visit(value);
  };

  visit(idl.types);
  visit(idl.accounts);
  return found;
}

describe("the prize enum agrees across the rule schema, the client and the program", () => {
  it("holds the type-level guard", () => {
    // The assertion happened at compile time; this keeps the constants referenced so
    // neither lint nor an unused-locals pass can delete the thing doing the work.
    expect(wireCoversRules).toBe(true);
    expect(rulesCoverWire).toBe(true);
  });

  it("names each prize exactly once", () => {
    // A duplicate would not fail the type check — the union would be unchanged — but
    // `payoutArray` maps positionally, so one prize would take two slots and the last
    // would be dropped.
    expect(new Set(PRIZE_ORDER).size).toBe(PRIZE_ORDER.length);
  });

  it("is as wide as the payout array the program actually stores", () => {
    const lengths = payoutBpsLengths(ESCROW_IDL);

    // Guards the guard. If `payout_bps` is renamed, `lengths` is empty and every
    // assertion below it passes vacuously — the failure mode that makes a test read as
    // coverage in review while checking nothing.
    expect(lengths.length).toBeGreaterThan(0);

    for (const length of lengths) expect(length).toBe(PRIZE_ORDER.length);
  });
});

/**
 * What this does not cover: that `ESCROW_IDL` still matches the Rust source. That is
 * `pnpm idl:check` (`scripts/sync-idl.mjs`), which regenerates the IDL and diffs it
 * against the committed copy. The chain is rule schema → `PRIZE_ORDER` → IDL → program,
 * and this file is the first two links; `idl:check` is the third.
 */
