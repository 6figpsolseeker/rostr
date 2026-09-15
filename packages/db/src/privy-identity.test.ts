import { afterEach, describe, expect, it } from "vitest";
import { createUser, findUserByWallet, getWallets, linkWallet } from "./identity.js";
import {
  PrivySignInError,
  signInWithPrivy,
  type VerifiedPrivyAccount,
} from "./privy-identity.js";
import { createTestDatabase, testWallet } from "./testing.js";
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

const NOW = new Date("2026-09-13T12:00:00Z");

function account(overrides: Partial<VerifiedPrivyAccount> = {}): VerifiedPrivyAccount {
  return {
    privyUserId: "did:privy:alice",
    verifiedEmail: "alice@example.com",
    embeddedSolanaWallets: [],
    x: null,
    ...overrides,
  };
}

interface IdentityColumns {
  privy_user_id: string | null;
  email_verified_at: string | null;
  x_subject: string | null;
  x_username: string | null;
}

async function columns(client: PGliteClient, userId: string): Promise<IdentityColumns> {
  const [r] = await client.query<IdentityColumns>(
    "SELECT privy_user_id, email_verified_at, x_subject, x_username FROM users WHERE id = $1",
    [userId],
  );
  return r!;
}

async function count(client: PGliteClient, sql: string): Promise<number> {
  const [r] = await client.query<{ n: number }>(sql);
  return Number(r!.n);
}

/** The refusal's code — and a failure if it resolved or threw something else. */
async function refusal(pending: Promise<unknown>): Promise<string> {
  const caught = await pending.then(
    () => null,
    (e: unknown) => e,
  );
  expect(caught).toBeInstanceOf(PrivySignInError);
  return (caught as PrivySignInError).code;
}

const JOINED = "SELECT count(*)::int AS n FROM users WHERE privy_user_id IS NOT NULL";

describe("signInWithPrivy — which account", () => {
  it("creates a verified account for a new person", async () => {
    const client = await fresh();
    const { user, isNew } = await signInWithPrivy(client, account(), NOW);

    expect(isNew).toBe(true);
    expect(user.email).toBe("alice@example.com");
    expect(user.displayName).toBe("alice");
    expect(user.emailVerified).toBe(true);
    expect(user.username).toBeNull();
    expect((await columns(client, user.id)).privy_user_id).toBe("did:privy:alice");
  });

  it("returns the same account on the next sign-in", async () => {
    const client = await fresh();
    const first = await signInWithPrivy(client, account(), NOW);
    const second = await signInWithPrivy(client, account(), NOW);

    expect(second.isNew).toBe(false);
    expect(second.user.id).toBe(first.user.id);
    expect(await count(client, "SELECT count(*)::int AS n FROM users")).toBe(1);
  });

  it("finds a joined account by Privy id, and leaves its email alone", async () => {
    const client = await fresh();
    const first = await signInWithPrivy(client, account(), NOW);
    const moved = await signInWithPrivy(
      client,
      account({ verifiedEmail: "alice@elsewhere.example" }),
      NOW,
    );

    expect(moved.user.id).toBe(first.user.id);
    expect(moved.user.email).toBe("alice@example.com");
  });

  it("attaches an existing email account instead of making a second one", async () => {
    const client = await fresh();
    const existing = await createUser(client, "Alice@Example.com", "Alice");

    const { user, isNew } = await signInWithPrivy(client, account(), NOW);

    expect(isNew).toBe(false);
    expect(user.id).toBe(existing.id);
    expect(user.displayName).toBe("Alice");
    expect(user.emailVerified).toBe(true);
    expect((await columns(client, existing.id)).privy_user_id).toBe("did:privy:alice");
    expect(await count(client, "SELECT count(*)::int AS n FROM users")).toBe(1);
  });

  it("keeps the first verification time when attaching an already-verified account", async () => {
    const client = await fresh();
    await createUser(client, "alice@example.com", "Alice");
    const earlier = "2026-08-01T00:00:00.000Z";
    await client.query("UPDATE users SET email_verified_at = $1", [earlier]);

    const { user } = await signInWithPrivy(client, account(), NOW);

    const stored = (await columns(client, user.id)).email_verified_at;
    expect(new Date(stored!).toISOString()).toBe(earlier);
  });

  it("refuses an email already joined to a different Privy account", async () => {
    const client = await fresh();
    const alice = await signInWithPrivy(client, account(), NOW);

    expect(
      await refusal(
        signInWithPrivy(client, account({ privyUserId: "did:privy:mallory" }), NOW),
      ),
    ).toBe("ACCOUNT_CONFLICT");
    expect((await columns(client, alice.user.id)).privy_user_id).toBe("did:privy:alice");
  });

  it("will not attach or create without a verified email", async () => {
    const client = await fresh();
    await createUser(client, "alice@example.com", "Alice");

    expect(await refusal(signInWithPrivy(client, account({ verifiedEmail: null }), NOW))).toBe(
      "EMAIL_REQUIRED",
    );
    expect(await refusal(signInWithPrivy(client, account({ verifiedEmail: "  " }), NOW))).toBe(
      "EMAIL_REQUIRED",
    );
    expect(await count(client, JOINED)).toBe(0);
  });

  it("carries on when the email's account was attached by this same login's other request", async () => {
    // Staged on one connection: the lookup by Privy id misses — it ran before the
    // other request committed — and the lookup by email then sees that request's
    // committed attach. Without the carve-out this is ACCOUNT_CONFLICT against
    // the account this login owns.
    const client = await fresh();
    const existing = await createUser(client, "alice@example.com", "Alice");
    await client.query("UPDATE users SET privy_user_id = $1 WHERE id = $2", [
      "did:privy:alice",
      existing.id,
    ]);

    let missed = false;
    const racing = {
      exec: (sql: string) => client.exec(sql),
      query: async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
        if (!missed && sql.includes("WHERE privy_user_id = $1 FOR UPDATE")) {
          missed = true;
          return [];
        }
        return client.query<T>(sql, params);
      },
    } as unknown as typeof client;

    const { user, isNew } = await signInWithPrivy(racing, account(), NOW);
    expect(missed).toBe(true);
    expect(user.id).toBe(existing.id);
    expect(isNew).toBe(false);
  });

  it("retries once when a concurrent sign-in wins a unique index", async () => {
    // PGlite is one connection, so the race is staged: the first INSERT fails the
    // way the loser of two concurrent first sign-ins does, after the winner has
    // committed its row.
    const client = await fresh();
    let raced = false;
    const racing = {
      exec: (sql: string) => client.exec(sql),
      query: async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
        if (!raced && sql.trimStart().startsWith("INSERT INTO users")) {
          raced = true;
          await client.exec("ROLLBACK");
          await client.query(
            "INSERT INTO users (email, display_name, email_verified_at, privy_user_id) VALUES ('alice@example.com', 'alice', now(), 'did:privy:alice')",
          );
          await client.exec("BEGIN");
          throw Object.assign(new Error("duplicate key value"), { code: "23505" });
        }
        return client.query<T>(sql, params);
      },
    } as unknown as typeof client;

    const { user, isNew } = await signInWithPrivy(racing, account(), NOW);

    expect(raced).toBe(true);
    expect(isNew).toBe(false);
    expect(user.email).toBe("alice@example.com");
    expect(await count(client, "SELECT count(*)::int AS n FROM users")).toBe(1);
  });

  it("signs a joined account in without an email", async () => {
    const client = await fresh();
    const first = await signInWithPrivy(client, account(), NOW);

    const again = await signInWithPrivy(client, account({ verifiedEmail: null }), NOW);
    expect(again.user.id).toBe(first.user.id);
  });
});

describe("signInWithPrivy — wallets", () => {
  it("records the embedded wallet as verified and primary", async () => {
    const client = await fresh();
    const wallet = testWallet(1).address;

    const { user } = await signInWithPrivy(
      client,
      account({ embeddedSolanaWallets: [wallet] }),
      NOW,
    );

    expect(await getWallets(client, user.id)).toEqual([
      expect.objectContaining({ address: wallet, isPrimary: true }),
    ]);
    // Verified is what makes an address invitable.
    expect((await findUserByWallet(client, wallet))?.id).toBe(user.id);
  });

  it("adds a wallet created after the first sign-in, once", async () => {
    const client = await fresh();
    const wallet = testWallet(1).address;
    const { user } = await signInWithPrivy(client, account(), NOW);
    expect(await getWallets(client, user.id)).toEqual([]);

    await signInWithPrivy(client, account({ embeddedSolanaWallets: [wallet] }), NOW);
    await signInWithPrivy(client, account({ embeddedSolanaWallets: [wallet] }), NOW);

    expect(await getWallets(client, user.id)).toHaveLength(1);
  });

  it("leaves an attached account's existing primary wallet primary", async () => {
    const client = await fresh();
    const existing = await createUser(client, "alice@example.com", "Alice");
    const external = testWallet(2).address;
    await linkWallet(client, existing.id, external, { verified: true });

    const embedded = testWallet(1).address;
    await signInWithPrivy(client, account({ embeddedSolanaWallets: [embedded] }), NOW);

    const wallets = await getWallets(client, existing.id);
    expect(wallets.find((w) => w.address === external)?.isPrimary).toBe(true);
    expect(wallets.find((w) => w.address === embedded)?.isPrimary).toBe(false);
  });

  it("refuses a wallet held by another account, and writes nothing", async () => {
    const client = await fresh();
    const bob = await createUser(client, "bob@example.com", "Bob");
    const wallet = testWallet(1).address;
    await linkWallet(client, bob.id, wallet, { verified: true });

    expect(
      await refusal(signInWithPrivy(client, account({ embeddedSolanaWallets: [wallet] }), NOW)),
    ).toBe("WALLET_TAKEN");

    // The account inserted before the wallet step rolled back with it.
    expect(await count(client, JOINED)).toBe(0);
  });
});

describe("signInWithPrivy — X", () => {
  it("records a linked X account and refreshes the handle", async () => {
    const client = await fresh();
    const { user } = await signInWithPrivy(
      client,
      account({ x: { subject: "12345", username: "alice" } }),
      NOW,
    );
    expect(await columns(client, user.id)).toMatchObject({
      x_subject: "12345",
      x_username: "alice",
    });

    await signInWithPrivy(
      client,
      account({ x: { subject: "12345", username: "alice_2" } }),
      NOW,
    );
    expect(await columns(client, user.id)).toMatchObject({
      x_subject: "12345",
      x_username: "alice_2",
    });
  });

  it("clears X when it has been unlinked in Privy", async () => {
    const client = await fresh();
    const { user } = await signInWithPrivy(
      client,
      account({ x: { subject: "12345", username: "alice" } }),
      NOW,
    );

    await signInWithPrivy(client, account({ x: null }), NOW);
    expect(await columns(client, user.id)).toMatchObject({ x_subject: null, x_username: null });
  });

  it("moves an X account off a stale holder instead of refusing the sign-in", async () => {
    // Privy lets one X account belong to one Privy user, so a second rostr row
    // still holding the subject holds a leftover — an unlink whose sync never
    // landed. It must not lock the person who holds it now out of rostr.
    const client = await fresh();
    const old = await signInWithPrivy(
      client,
      account({ x: { subject: "12345", username: "alice" } }),
      NOW,
    );

    const { user } = await signInWithPrivy(
      client,
      account({
        privyUserId: "did:privy:bob",
        verifiedEmail: "bob@example.com",
        x: { subject: "12345", username: "alice" },
      }),
      NOW,
    );

    expect(await columns(client, user.id)).toMatchObject({ x_subject: "12345" });
    expect(await columns(client, old.user.id)).toMatchObject({
      x_subject: null,
      x_username: null,
    });
  });
});

describe("migration 0046", () => {
  it("refuses a second account with the same Privy id", async () => {
    const client = await fresh();
    await signInWithPrivy(client, account(), NOW);
    await expect(
      client.query(
        "INSERT INTO users (email, display_name, privy_user_id) VALUES ('b@example.com', 'b', 'did:privy:alice')",
      ),
    ).rejects.toThrow(/users_privy_user_id_idx/);
  });

  it("refuses a blank Privy id", async () => {
    const client = await fresh();
    await expect(
      client.query(
        "INSERT INTO users (email, display_name, privy_user_id) VALUES ('b@example.com', 'b', '  ')",
      ),
    ).rejects.toThrow(/users_privy_user_id_not_blank/);
  });

  it("refuses a handle with no X account behind it", async () => {
    const client = await fresh();
    await expect(
      client.query(
        "INSERT INTO users (email, display_name, x_username) VALUES ('c@example.com', 'c', 'handle')",
      ),
    ).rejects.toThrow(/users_x_handle_needs_subject/);
  });
});
