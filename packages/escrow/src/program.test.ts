import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { ESCROW_IDL } from "./idl.js";
import {
  ESCROW_PROGRAM_ID,
  leagueAddresses,
  leagueIdBytes,
  leagueIdFromBytes,
  leaguePda,
  membershipPda,
  scoresPda,
  vaultPda,
} from "./program.js";

/**
 * These are pure, so they run in `pnpm test` with no validator and no toolchain.
 * The corresponding proof that these addresses are the ones the *program*
 * derives lives in `programs/rostr-escrow/tests/` — the two have to agree, and
 * only one of them can be checked without a chain.
 */

const UUID = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

describe("league id encoding", () => {
  it("round-trips a UUID through its raw bytes", () => {
    expect(leagueIdFromBytes(leagueIdBytes(UUID))).toBe(UUID);
  });

  it("produces exactly the sixteen bytes the seed uses", () => {
    const bytes = leagueIdBytes(UUID);
    expect(bytes).toHaveLength(16);
    expect(bytes[0]).toBe(0x3f);
    expect(bytes[15]).toBe(0x5d);
  });

  it("ignores dash placement, because dashes are formatting", () => {
    expect(leagueIdBytes(UUID)).toEqual(leagueIdBytes(UUID.replace(/-/g, "")));
  });

  it("accepts either case", () => {
    expect(leagueIdBytes(UUID.toUpperCase())).toEqual(leagueIdBytes(UUID));
  });

  it("rejects anything that is not a UUID", () => {
    // A silent wrong answer here would address an account the program never
    // wrote, which reads as a logic bug rather than a bad input.
    expect(() => leagueIdBytes("not-a-uuid")).toThrow(/not a UUID/);
    expect(() => leagueIdBytes("")).toThrow(/not a UUID/);
    expect(() => leagueIdBytes(UUID.slice(0, -1))).toThrow(/not a UUID/);
  });

  it("rejects the wrong number of bytes coming back", () => {
    expect(() => leagueIdFromBytes(new Uint8Array(15))).toThrow(/16 bytes/);
  });
});

describe("addresses", () => {
  it("uses the program id the IDL was built with", () => {
    // Guards the drift that would make every call target a program that is not
    // there — and it would look like the cluster was wrong, not the constant.
    expect(ESCROW_PROGRAM_ID.toBase58()).toBe(ESCROW_IDL.address);
  });

  const COMMISSIONER = new PublicKey("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin");

  it("derives a league deterministically", () => {
    expect(leaguePda(UUID, COMMISSIONER).toBase58()).toBe(
      leaguePda(UUID, COMMISSIONER).toBase58(),
    );
  });

  it("gives different leagues different addresses", () => {
    const other = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5e";
    expect(leaguePda(UUID, COMMISSIONER).toBase58()).not.toBe(
      leaguePda(other, COMMISSIONER).toBase58(),
    );
  });

  it("gives one league id a different address under every commissioner", () => {
    // The squatting fix. League ids are public, so with the id alone as the seed
    // a stranger could create a league's account before its commissioner did.
    // Their attempt now lands at an address derived from their own key, and
    // everything hanging off the league moves with it.
    const stranger = new PublicKey("So11111111111111111111111111111111111111112");
    const real = leaguePda(UUID, COMMISSIONER);
    const squat = leaguePda(UUID, stranger);

    expect(squat.toBase58()).not.toBe(real.toBase58());
    expect(vaultPda(squat).toBase58()).not.toBe(vaultPda(real).toBase58());
    expect(scoresPda(UUID, stranger).toBase58()).not.toBe(
      scoresPda(UUID, COMMISSIONER).toBase58(),
    );
  });

  it("derives the vault from the league, not the league id", () => {
    const league = leaguePda(UUID, COMMISSIONER);
    expect(vaultPda(league).toBase58()).toBe(
      leagueAddresses(UUID, COMMISSIONER).vault.toBase58(),
    );
  });

  it("seeds a membership by league and member together", () => {
    const league = leaguePda(UUID, COMMISSIONER);
    const a = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    const b = new PublicKey("So11111111111111111111111111111111111111112");

    // Same member, different league, and vice versa — both must differ, which
    // is what stops one membership standing in for another.
    expect(membershipPda(league, a).toBase58()).not.toBe(membershipPda(league, b).toBase58());
    expect(membershipPda(league, a).toBase58()).not.toBe(
      membershipPda(
        leaguePda("00000000-0000-4000-8000-000000000000", COMMISSIONER),
        a,
      ).toBase58(),
    );
  });
});
