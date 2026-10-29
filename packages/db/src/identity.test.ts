import { afterEach, describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";
import {
  createUser,
  findUserByEmail,
  getWallets,
  IdentityError,
  linkWallet,
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

  /*
    Two tabs linking two different wallets both count zero wallets and both ask
    for primary. The loser used to hit `wallets_one_primary_per_user` and be told
    WALLET_TAKEN about a wallet nobody holds (#82). Staged by making the count
    miss the first tab's row — PGlite has one connection, so the interleaving
    itself cannot be produced.
  */
  async function racedSecondLink(client: PGliteClient, userId: string) {
    await linkWallet(client, userId, address(1));
    const raced: PGliteClient = Object.create(client);
    raced.query = (sql, values) =>
      sql.includes("count(*)")
        ? Promise.resolve([{ n: 0 }] as never)
        : client.query(sql, values);
    return raced;
  }

  it("links the loser of a primary race as a second wallet, not WALLET_TAKEN", async () => {
    const client = await fresh();
    const alice = await createUser(client, "a@example.com", "Alice");
    const raced = await racedSecondLink(client, alice.id);

    const second = await linkWallet(raced, alice.id, address(2));

    expect(second.isPrimary).toBe(false);
    const wallets = await getWallets(client, alice.id);
    expect(wallets.map((w) => w.isPrimary).sort()).toEqual([false, true]);
  });

  it("survives that race inside a transaction, where a retry after an error cannot run", async () => {
    const client = await fresh();
    const alice = await createUser(client, "a@example.com", "Alice");
    const raced = await racedSecondLink(client, alice.id);

    await raced.query("BEGIN");
    const second = await linkWallet(raced, alice.id, address(2));
    await raced.query("COMMIT");

    expect(second.isPrimary).toBe(false);
    expect(await getWallets(client, alice.id)).toHaveLength(2);
  });
});
