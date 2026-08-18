import { afterEach, describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";
import {
  createUser,
  findUserByEmail,
  getWallets,
  IdentityError,
  issueVerificationToken,
  linkWallet,
  verifySignInCode,
  MAX_CODE_ATTEMPTS,
  VERIFICATION_TTL_MS,
} from "./identity.js";
import { createTestDatabase } from "./testing.js";
import type { PGliteClient } from "./testing.js";

let db: PGliteClient | undefined;

afterEach(async () => {
  await db?.close();
  db = undefined;
});

async function fresh(): Promise<PGliteClient> {
  db = await createTestDatabase();
  return db;
}

const address = (seed: number): string =>
  bs58.encode(ed25519.getPublicKey(new Uint8Array(32).fill(seed)));

describe("createUser", () => {
  it("creates an unverified user", async () => {
    const client = await fresh();
    const user = await createUser(client, "a@example.com", "Alice");

    expect(user.email).toBe("a@example.com");
    expect(user.emailVerified).toBe(false);
  });

  it("rejects a duplicate email regardless of case", async () => {
    const client = await fresh();
    await createUser(client, "a@example.com", "Alice");

    await expect(createUser(client, "A@EXAMPLE.COM", "Impostor")).rejects.toSatisfy(
      (e: unknown) => e instanceof IdentityError && e.code === "EMAIL_TAKEN",
    );
  });

  it("finds a user by email case-insensitively", async () => {
    const client = await fresh();
    const created = await createUser(client, "a@example.com", "Alice");
    const found = await findUserByEmail(client, "A@Example.Com");

    expect(found?.id).toBe(created.id);
  });
});

describe("signing in with a code", () => {
  const EMAIL = "a@example.com";

  it("signs in with the right code", async () => {
    const client = await fresh();
    const user = await createUser(client, EMAIL, "Alice");
    const { token } = await issueVerificationToken(client, user.id);

    const verified = await verifySignInCode(client, EMAIL, token);
    expect(verified.emailVerified).toBe(true);
  });

  it("issues six digits, which is what makes it typeable", async () => {
    const client = await fresh();
    const user = await createUser(client, EMAIL, "Alice");
    const { token } = await issueVerificationToken(client, user.id);

    expect(token).toMatch(/^[0-9]{6}$/);
  });

  it("stores only the hash, never the code", async () => {
    // A six-digit code is far weaker than the token it replaced, so the
    // database must be no help at all: a leak yields hashes, and reversing a
    // SHA-256 of an unknown-at-rest value is the attacker's problem.
    const client = await fresh();
    const user = await createUser(client, EMAIL, "Alice");
    const { token } = await issueVerificationToken(client, user.id);

    const rows = await client.query<{ token_hash: string }>(
      "SELECT token_hash FROM email_verification_tokens",
    );
    expect(rows[0]?.token_hash).not.toBe(token);
    expect(rows[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is single use", async () => {
    const client = await fresh();
    const user = await createUser(client, EMAIL, "Alice");
    const { token } = await issueVerificationToken(client, user.id);

    await verifySignInCode(client, EMAIL, token);
    await expect(verifySignInCode(client, EMAIL, token)).rejects.toSatisfy(
      (e: unknown) => e instanceof IdentityError && e.code === "TOKEN_INVALID",
    );
  });

  it("supersedes an earlier code", async () => {
    const client = await fresh();
    const user = await createUser(client, EMAIL, "Alice");
    const first = await issueVerificationToken(client, user.id);
    await issueVerificationToken(client, user.id);

    await expect(verifySignInCode(client, EMAIL, first.token)).rejects.toSatisfy(
      (e: unknown) => e instanceof IdentityError && e.code === "TOKEN_INVALID",
    );
  });

  it("survives a wrong guess rather than dying on a typo", async () => {
    // Destroying the code on the first mistake would send people back to their
    // inbox for a mistyped digit, which is its own kind of broken.
    const client = await fresh();
    const user = await createUser(client, EMAIL, "Alice");
    const { token } = await issueVerificationToken(client, user.id);

    await expect(verifySignInCode(client, EMAIL, wrong(token))).rejects.toSatisfy(
      (e: unknown) => e instanceof IdentityError && e.code === "TOKEN_INVALID",
    );

    const verified = await verifySignInCode(client, EMAIL, token);
    expect(verified.emailVerified).toBe(true);
  });

  it("destroys the code after MAX_CODE_ATTEMPTS wrong guesses", async () => {
    // The whole reason six digits is safe. Without this, a million guesses is
    // an afternoon's work.
    const client = await fresh();
    const user = await createUser(client, EMAIL, "Alice");
    const { token } = await issueVerificationToken(client, user.id);

    for (let i = 0; i < MAX_CODE_ATTEMPTS; i++) {
      await expect(verifySignInCode(client, EMAIL, wrong(token))).rejects.toThrow();
    }

    // Even the correct code is now worthless.
    await expect(verifySignInCode(client, EMAIL, token)).rejects.toSatisfy(
      (e: unknown) => e instanceof IdentityError && e.code === "TOKEN_INVALID",
    );

    const rows = await client.query("SELECT user_id FROM email_verification_tokens");
    expect(rows).toEqual([]);
  });

  it("counts attempts against the code, so a new one starts fresh", async () => {
    const client = await fresh();
    const user = await createUser(client, EMAIL, "Alice");
    const first = await issueVerificationToken(client, user.id);

    for (let i = 0; i < MAX_CODE_ATTEMPTS - 1; i++) {
      await expect(verifySignInCode(client, EMAIL, wrong(first.token))).rejects.toThrow();
    }

    const second = await issueVerificationToken(client, user.id);
    const [row] = await client.query<{ attempts: number }>(
      "SELECT attempts FROM email_verification_tokens",
    );
    expect(Number(row?.attempts)).toBe(0);

    const verified = await verifySignInCode(client, EMAIL, second.token);
    expect(verified.emailVerified).toBe(true);
  });

  it("rejects an expired code and consumes it anyway", async () => {
    const client = await fresh();
    const user = await createUser(client, EMAIL, "Alice");
    const issuedAt = new Date("2026-08-01T00:00:00Z");
    const { token } = await issueVerificationToken(client, user.id, issuedAt);

    const tooLate = new Date(issuedAt.getTime() + VERIFICATION_TTL_MS + 1000);
    await expect(verifySignInCode(client, EMAIL, token, tooLate)).rejects.toSatisfy(
      (e: unknown) => e instanceof IdentityError && e.code === "TOKEN_EXPIRED",
    );

    const rows = await client.query("SELECT user_id FROM email_verification_tokens");
    expect(rows).toEqual([]);
  });

  it("expires in minutes, not a day", async () => {
    // The link could afford 24 hours; a six-digit code cannot. The window in
    // which guessing is possible at all is part of what pays for the shortness.
    expect(VERIFICATION_TTL_MS).toBeLessThanOrEqual(15 * 60 * 1000);
  });

  it("says the same thing for an unknown address as for a wrong code", async () => {
    // Distinguishing them would answer "does this person have an account here",
    // which `beginEmailSignIn` goes to some trouble not to.
    const client = await fresh();
    await expect(verifySignInCode(client, "nobody@example.com", "123456")).rejects.toSatisfy(
      (e: unknown) => e instanceof IdentityError && e.code === "TOKEN_INVALID",
    );
  });

  it("rejects a code when none is outstanding", async () => {
    const client = await fresh();
    await createUser(client, EMAIL, "Alice");
    await expect(verifySignInCode(client, EMAIL, "123456")).rejects.toSatisfy(
      (e: unknown) => e instanceof IdentityError && e.code === "TOKEN_INVALID",
    );
  });

  it("rejects issuing for a user who does not exist", async () => {
    const client = await fresh();
    await expect(
      issueVerificationToken(client, "00000000-0000-4000-8000-000000000000"),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof IdentityError && e.code === "USER_NOT_FOUND",
    );
  });
});

/** A code that is definitely not this one, and still six digits. */
function wrong(code: string): string {
  const shifted = (Number(code) + 1) % 1_000_000;
  return shifted.toString().padStart(6, "0");
}

describe("linkWallet", () => {
  it("makes the first wallet primary", async () => {
    const client = await fresh();
    const user = await createUser(client, "a@example.com", "Alice");

    const wallet = await linkWallet(client, user.id, address(1));
    expect(wallet.isPrimary).toBe(true);
  });

  it("does not make later wallets primary", async () => {
    const client = await fresh();
    const user = await createUser(client, "a@example.com", "Alice");

    await linkWallet(client, user.id, address(1));
    const second = await linkWallet(client, user.id, address(2));

    expect(second.isPrimary).toBe(false);
    expect(await getWallets(client, user.id)).toHaveLength(2);
  });

  it("is idempotent for the same user and address", async () => {
    const client = await fresh();
    const user = await createUser(client, "a@example.com", "Alice");

    const first = await linkWallet(client, user.id, address(1));
    const again = await linkWallet(client, user.id, address(1));

    expect(again.id).toBe(first.id);
    expect(await getWallets(client, user.id)).toHaveLength(1);
  });

  it("refuses a wallet already linked to someone else", async () => {
    const client = await fresh();
    const alice = await createUser(client, "a@example.com", "Alice");
    const bob = await createUser(client, "b@example.com", "Bob");

    await linkWallet(client, alice.id, address(1));
    await expect(linkWallet(client, bob.id, address(1))).rejects.toSatisfy(
      (e: unknown) => e instanceof IdentityError && e.code === "WALLET_TAKEN",
    );
  });

  it("rejects a malformed address", async () => {
    const client = await fresh();
    const user = await createUser(client, "a@example.com", "Alice");

    await expect(linkWallet(client, user.id, "0xdeadbeef")).rejects.toSatisfy(
      (e: unknown) => e instanceof IdentityError && e.code === "INVALID_WALLET",
    );
  });

  it("says WALLET_TAKEN when the unique index refuses, not just when the check does", async () => {
    // The claimed-check runs on its own, outside any transaction, so two tabs
    // linking one address can both pass it. The index then refuses the loser —
    // the right outcome reported as an unhandled 500, because the caller only
    // maps `IdentityError`.
    //
    // The race cannot be staged on single-connection PGlite, so the row is
    // inserted directly: the check does not see it in the shape it looks for,
    // and the statement below is the one that has to answer.
    const client = await fresh();
    const alice = await createUser(client, "a@example.com", "Alice");
    const bob = await createUser(client, "b@example.com", "Bob");

    await client.query(
      "INSERT INTO wallets (user_id, address, is_primary) VALUES ($1, $2, true)",
      [alice.id, address(1)],
    );

    await expect(linkWallet(client, bob.id, address(1))).rejects.toSatisfy(
      (e: unknown) => e instanceof IdentityError && e.code === "WALLET_TAKEN",
    );
  });
});
