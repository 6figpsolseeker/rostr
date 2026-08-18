import { afterEach, describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";
import { buildWalletLinkMessage, sha256Hex } from "@rostr/core";
import { beginEmailSignIn, getWallets, verifySignInCode } from "./identity.js";
import {
  CHALLENGE_TTL_MS,
  createSession,
  issueWalletChallenge,
  linkWalletWithSignature,
  purgeExpiredSessions,
  resolveSession,
  revokeAllSessions,
  revokeSession,
  SESSION_TTL_MS,
} from "./sessions.js";
import { createTestDatabase } from "./testing.js";
import type { PGliteClient } from "./testing.js";

let db: PGliteClient | undefined;

afterEach(async () => {
  await db?.close();
  db = undefined;
});

const NOW = new Date("2026-08-22T18:00:00Z");

function keypair(seed: number): { secret: Uint8Array; address: string } {
  const secret = new Uint8Array(32).fill(seed);
  return { secret, address: bs58.encode(ed25519.getPublicKey(secret)) };
}

const sign = (secret: Uint8Array, message: string): string =>
  bs58.encode(ed25519.sign(new TextEncoder().encode(message), secret));

async function signedIn(email = "figp@example.com") {
  db = await createTestDatabase();
  const { user } = await beginEmailSignIn(db, email, "figp", NOW);
  const session = await createSession(db, user.id, NOW);
  return { client: db, user, session };
}

describe("beginEmailSignIn", () => {
  it("registers a new account and issues a token", async () => {
    db = await createTestDatabase();
    const result = await beginEmailSignIn(db, "new@example.com", "New", NOW);

    expect(result.isNew).toBe(true);
    expect(result.user.email).toBe("new@example.com");
    // Six digits, typed rather than followed — see migration 0031.
    expect(result.token.token).toMatch(/^[0-9]{6}$/);
  });

  it("reuses the account on a second sign-in", async () => {
    // One entry point for both cases. Separate register and sign-in routes would
    // respond differently, and the difference tells anyone who asks whether an
    // email has an account here.
    db = await createTestDatabase();
    const first = await beginEmailSignIn(db, "again@example.com", "Again", NOW);
    const second = await beginEmailSignIn(db, "again@example.com", undefined, NOW);

    expect(second.isNew).toBe(false);
    expect(second.user.id).toBe(first.user.id);
  });

  it("supersedes the previous code", async () => {
    // Otherwise an old code forwarded to someone else still works.
    db = await createTestDatabase();
    const first = await beginEmailSignIn(db, "super@example.com", "S", NOW);
    await beginEmailSignIn(db, "super@example.com", undefined, NOW);

    await expect(
      verifySignInCode(db, "super@example.com", first.token.token, NOW),
    ).rejects.toMatchObject({ code: "TOKEN_INVALID" });
  });

  it("defaults a display name from the address", async () => {
    db = await createTestDatabase();
    const { user } = await beginEmailSignIn(db, "figp@example.com", undefined, NOW);

    expect(user.displayName).toBe("figp");
  });

  it("rejects something that is not an email", async () => {
    db = await createTestDatabase();
    await expect(beginEmailSignIn(db, "not-an-email", "X", NOW)).rejects.toThrow();
  });

  it("keeps the original verification time across later sign-ins", async () => {
    // These codes double as sign-in credentials, so this runs on every login.
    db = await createTestDatabase();
    const first = await beginEmailSignIn(db, "keep@example.com", "K", NOW);
    await verifySignInCode(db, "keep@example.com", first.token.token, NOW);

    const later = new Date(NOW.getTime() + 86_400_000);
    const second = await beginEmailSignIn(db, "keep@example.com", undefined, later);
    await verifySignInCode(db, "keep@example.com", second.token.token, later);

    const [row] = await db.query<{ email_verified_at: string }>(
      "SELECT email_verified_at FROM users WHERE lower(email) = 'keep@example.com'",
    );
    expect(new Date(row!.email_verified_at).toISOString()).toBe(NOW.toISOString());
  });
});

describe("sessions", () => {
  it("resolves a fresh token to its user", async () => {
    const { client, user, session } = await signedIn();

    expect((await resolveSession(client, session.token, NOW))?.id).toBe(user.id);
  });

  it("stores only the hash of the token", async () => {
    // A database leak must not hand an attacker working logins.
    const { client, session } = await signedIn();

    const [row] = await client.query<{ token_hash: string }>("SELECT token_hash FROM sessions");

    expect(row!.token_hash).toBe(sha256Hex(session.token));
    expect(row!.token_hash).not.toBe(session.token);
  });

  it("rejects an unknown token", async () => {
    const { client } = await signedIn();

    expect(await resolveSession(client, "not-a-real-token", NOW)).toBeNull();
  });

  it("rejects an empty token", async () => {
    const { client } = await signedIn();

    expect(await resolveSession(client, "", NOW)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const { client, session } = await signedIn();
    const after = new Date(NOW.getTime() + SESSION_TTL_MS + 1000);

    expect(await resolveSession(client, session.token, after)).toBeNull();
  });

  it("holds right up to the expiry", async () => {
    const { client, session } = await signedIn();
    const justBefore = new Date(NOW.getTime() + SESSION_TTL_MS - 1000);

    expect(await resolveSession(client, session.token, justBefore)).not.toBeNull();
  });

  it("rejects a revoked token", async () => {
    const { client, session } = await signedIn();
    await revokeSession(client, session.token, NOW);

    expect(await resolveSession(client, session.token, NOW)).toBeNull();
  });

  it("treats revoking an unknown token as a no-op", async () => {
    const { client } = await signedIn();

    await expect(revokeSession(client, "nonsense", NOW)).resolves.toBeUndefined();
  });

  it("signs out everywhere", async () => {
    // What a user reaches for after losing a laptop.
    const { client, user } = await signedIn();
    const second = await createSession(client, user.id, NOW);
    const third = await createSession(client, user.id, NOW);

    expect(await revokeAllSessions(client, user.id, NOW)).toBe(3);
    expect(await resolveSession(client, second.token, NOW)).toBeNull();
    expect(await resolveSession(client, third.token, NOW)).toBeNull();
  });

  it("gives every session a distinct token", async () => {
    const { client, user } = await signedIn();
    const tokens = new Set<string>();

    for (let i = 0; i < 10; i++) {
      tokens.add((await createSession(client, user.id, NOW)).token);
    }

    expect(tokens.size).toBe(10);
  });

  it("refuses a session for a user who does not exist", async () => {
    const { client } = await signedIn();

    await expect(
      createSession(client, "00000000-0000-0000-0000-000000000000", NOW),
    ).rejects.toMatchObject({ code: "USER_NOT_FOUND" });
  });

  it("purges expired rows", async () => {
    const { client, user } = await signedIn();
    await createSession(client, user.id, NOW);

    const after = new Date(NOW.getTime() + SESSION_TTL_MS + 1000);

    expect(await purgeExpiredSessions(client, after)).toBe(2);
    expect(await purgeExpiredSessions(client, after)).toBe(0);
  });

  it("leaves live sessions alone when purging", async () => {
    const { client, session } = await signedIn();

    expect(await purgeExpiredSessions(client, NOW)).toBe(0);
    expect(await resolveSession(client, session.token, NOW)).not.toBeNull();
  });
});

describe("wallet linking", () => {
  it("links a wallet whose holder signs the challenge", async () => {
    const { client, user } = await signedIn();
    const kp = keypair(7);

    const challenge = await issueWalletChallenge(client, user.id, kp.address, NOW);
    const wallet = await linkWalletWithSignature(
      client,
      user.id,
      kp.address,
      sign(kp.secret, challenge.message),
      NOW,
    );

    expect(wallet.address).toBe(kp.address);
    expect(wallet.isPrimary).toBe(true);
    expect(await getWallets(client, user.id)).toHaveLength(1);
  });

  it("names the account and the wallet in what gets signed", async () => {
    // Wallets show this text. It has to say what the signature does.
    const { client, user } = await signedIn();
    const kp = keypair(8);

    const challenge = await issueWalletChallenge(client, user.id, kp.address, NOW);

    expect(challenge.message).toContain(user.email);
    expect(challenge.message).toContain(kp.address);
    expect(challenge.message).toMatch(/moves no funds/i);
  });

  it("rejects a signature from a different wallet", async () => {
    // The attack this exists to stop: claiming an address you do not hold,
    // including one already holding a league stake.
    const { client, user } = await signedIn();
    const mine = keypair(9);
    const theirs = keypair(10);

    const challenge = await issueWalletChallenge(client, user.id, theirs.address, NOW);

    await expect(
      linkWalletWithSignature(
        client,
        user.id,
        theirs.address,
        sign(mine.secret, challenge.message),
        NOW,
      ),
    ).rejects.toMatchObject({ code: "BAD_SIGNATURE" });
  });

  it("rejects a signature over a message the server did not issue", async () => {
    const { client, user } = await signedIn();
    const kp = keypair(11);
    await issueWalletChallenge(client, user.id, kp.address, NOW);

    const forged = buildWalletLinkMessage({
      walletAddress: kp.address,
      email: user.email,
      nonce: "a-nonce-i-made-up",
    });

    await expect(
      linkWalletWithSignature(client, user.id, kp.address, sign(kp.secret, forged), NOW),
    ).rejects.toMatchObject({ code: "BAD_SIGNATURE" });
  });

  it("refuses to reuse a challenge", async () => {
    // A signature captured once must not work twice.
    const { client, user } = await signedIn();
    const kp = keypair(12);

    const challenge = await issueWalletChallenge(client, user.id, kp.address, NOW);
    const signature = sign(kp.secret, challenge.message);

    await linkWalletWithSignature(client, user.id, kp.address, signature, NOW);

    await expect(
      linkWalletWithSignature(client, user.id, kp.address, signature, NOW),
    ).rejects.toMatchObject({ code: "CHALLENGE_NOT_FOUND" });
  });

  it("consumes the challenge even when the signature is wrong", async () => {
    // Otherwise one nonce absorbs unlimited attempts.
    const { client, user } = await signedIn();
    const kp = keypair(13);
    const other = keypair(14);

    const challenge = await issueWalletChallenge(client, user.id, kp.address, NOW);

    await expect(
      linkWalletWithSignature(
        client,
        user.id,
        kp.address,
        sign(other.secret, challenge.message),
        NOW,
      ),
    ).rejects.toMatchObject({ code: "BAD_SIGNATURE" });

    await expect(
      linkWalletWithSignature(
        client,
        user.id,
        kp.address,
        sign(kp.secret, challenge.message),
        NOW,
      ),
    ).rejects.toMatchObject({ code: "CHALLENGE_NOT_FOUND" });
  });

  it("rejects an expired challenge", async () => {
    const { client, user } = await signedIn();
    const kp = keypair(15);

    const challenge = await issueWalletChallenge(client, user.id, kp.address, NOW);
    const late = new Date(NOW.getTime() + CHALLENGE_TTL_MS + 1000);

    await expect(
      linkWalletWithSignature(
        client,
        user.id,
        kp.address,
        sign(kp.secret, challenge.message),
        late,
      ),
    ).rejects.toMatchObject({ code: "CHALLENGE_EXPIRED" });
  });

  it("supersedes an outstanding challenge for the same wallet", async () => {
    // A stale nonce must not sit around waiting to be replayed.
    const { client, user } = await signedIn();
    const kp = keypair(16);

    const first = await issueWalletChallenge(client, user.id, kp.address, NOW);
    const second = await issueWalletChallenge(client, user.id, kp.address, NOW);

    expect(second.nonce).not.toBe(first.nonce);

    await expect(
      linkWalletWithSignature(client, user.id, kp.address, sign(kp.secret, first.message), NOW),
    ).rejects.toMatchObject({ code: "BAD_SIGNATURE" });
  });

  it("refuses to link without a challenge at all", async () => {
    const { client, user } = await signedIn();
    const kp = keypair(17);

    await expect(
      linkWalletWithSignature(client, user.id, kp.address, "signature", NOW),
    ).rejects.toMatchObject({ code: "CHALLENGE_NOT_FOUND" });
  });

  it("rejects an address that is not a Solana public key", async () => {
    const { client, user } = await signedIn();

    await expect(
      issueWalletChallenge(client, user.id, "definitely-not-a-key", NOW),
    ).rejects.toMatchObject({ code: "INVALID_WALLET" });
  });

  it("refuses a wallet already linked to someone else", async () => {
    const { client, user } = await signedIn();
    const kp = keypair(18);

    const mine = await issueWalletChallenge(client, user.id, kp.address, NOW);
    await linkWalletWithSignature(
      client,
      user.id,
      kp.address,
      sign(kp.secret, mine.message),
      NOW,
    );

    const { user: other } = await beginEmailSignIn(client, "other@example.com", "Other", NOW);
    const theirs = await issueWalletChallenge(client, other.id, kp.address, NOW);

    await expect(
      linkWalletWithSignature(
        client,
        other.id,
        kp.address,
        sign(kp.secret, theirs.message),
        NOW,
      ),
    ).rejects.toMatchObject({ code: "WALLET_TAKEN" });
  });
});
