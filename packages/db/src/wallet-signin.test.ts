import { afterEach, describe, expect, it } from "vitest";
import { buildWalletLinkMessage, buildWalletSignInMessage } from "@rostr/core";
import { createUser, linkWallet } from "./identity.js";
import { issueWalletChallenge, linkWalletWithSignature } from "./sessions.js";
import { createTestDatabase, testWallet } from "./testing.js";
import type { PGliteClient } from "./testing.js";
import { issueWalletSignInChallenge, signInWithWallet } from "./wallet-signin.js";
import { resolveSession } from "./sessions.js";

let db: PGliteClient | undefined;

afterEach(async () => {
  await db?.close();
  db = undefined;
});

interface Fixture {
  client: PGliteClient;
  userId: string;
  email: string;
  address: string;
  sign: (message: string) => string;
}

/** A verified account holding a linked wallet we can actually sign with. */
async function setup(): Promise<Fixture> {
  db = await createTestDatabase();

  // `testWallet` already exists for exactly this, and its curve library is a
  // dependency of this package — a second signing library would be a second
  // implementation of the one thing these tests are checking.
  const wallet = testWallet(7);
  const address = wallet.address;
  const sign = wallet.sign;

  const email = "returning@example.test";
  const user = await createUser(db, email, "Returning");

  // Linked the way a real member links: challenge, signature, verification.
  // `linkWallet` alone leaves `verified_at` null — deliberately, since an
  // address somebody merely typed proves nothing — and `findUserByWallet`
  // requires it, so a fixture taking the shortcut would test a state the
  // application cannot produce.
  const link = await issueWalletChallenge(db, user.id, address);
  await linkWalletWithSignature(db, user.id, address, wallet.sign(link.message));

  return { client: db, userId: user.id, email, address, sign };
}

describe("issueWalletSignInChallenge", () => {
  it("issues a challenge for a linked wallet", async () => {
    const fx = await setup();
    const challenge = await issueWalletSignInChallenge(fx.client, fx.address);

    expect(challenge.message).toContain("rostr: sign in");
    expect(challenge.message).toContain(fx.address);
  });

  it("never puts the account's email in the message", async () => {
    const fx = await setup();
    const challenge = await issueWalletSignInChallenge(fx.client, fx.address);

    // The signer has not proved who they are yet — that is what the signature
    // is for. Naming the account in the prompt would disclose it to whoever is
    // holding the wallet before anything is established.
    expect(challenge.message).not.toContain(fx.email);
  });

  it("refuses a wallet nobody has linked, distinguishably", async () => {
    const fx = await setup();
    const stranger = testWallet(11).address;

    // The screen has to be able to say "sign in by email once and link it",
    // which it cannot do unless told which refusal this is.
    await expect(issueWalletSignInChallenge(fx.client, stranger)).rejects.toMatchObject({
      code: "WALLET_NOT_LINKED",
    });
  });

  it("refuses an unverified wallet", async () => {
    const fx = await setup();
    const other = await createUser(fx.client, "other@example.test", "Other");
    const address = testWallet(12).address;
    // The shortcut on purpose: linked, never verified.
    await linkWallet(fx.client, other.id, address);

    // An address somebody typed but never proved must not open a session.
    await expect(issueWalletSignInChallenge(fx.client, address)).rejects.toMatchObject({
      code: "WALLET_NOT_LINKED",
    });
  });

  it("refuses something that is not a public key", async () => {
    const fx = await setup();
    await expect(issueWalletSignInChallenge(fx.client, "not-a-key")).rejects.toMatchObject({
      code: "INVALID_WALLET",
    });
  });
});

describe("signInWithWallet", () => {
  it("opens a real session for the right signature", async () => {
    const fx = await setup();
    const challenge = await issueWalletSignInChallenge(fx.client, fx.address);

    const { user, session } = await signInWithWallet(
      fx.client,
      fx.address,
      fx.sign(challenge.message),
    );

    expect(user.id).toBe(fx.userId);
    // Not merely returned — usable. A token that does not validate is a sign-in
    // that only appears to have worked.
    expect(await resolveSession(fx.client, session.token)).not.toBeNull();
  });

  it("rejects a signature over a different nonce", async () => {
    const fx = await setup();
    await issueWalletSignInChallenge(fx.client, fx.address);

    const forged = buildWalletSignInMessage({ walletAddress: fx.address, nonce: "made-up" });
    await expect(
      signInWithWallet(fx.client, fx.address, fx.sign(forged)),
    ).rejects.toMatchObject({ code: "BAD_SIGNATURE" });
  });

  it("will not accept a wallet-link signature as a sign-in", async () => {
    // The reason the two messages carry different prefixes. Without it, a
    // linking prompt — approved by somebody who thought they were adding a
    // wallet to an account they were already inside — would double as a session
    // for that account.
    const fx = await setup();
    const challenge = await issueWalletSignInChallenge(fx.client, fx.address);
    const nonce = challenge.nonce;

    const linkMessage = buildWalletLinkMessage({
      walletAddress: fx.address,
      email: fx.email,
      nonce,
    });

    await expect(
      signInWithWallet(fx.client, fx.address, fx.sign(linkMessage)),
    ).rejects.toMatchObject({ code: "BAD_SIGNATURE" });
  });

  it("spends the challenge even when the signature is wrong", async () => {
    const fx = await setup();
    const challenge = await issueWalletSignInChallenge(fx.client, fx.address);

    const wrong = buildWalletSignInMessage({ walletAddress: fx.address, nonce: "wrong" });
    await expect(signInWithWallet(fx.client, fx.address, fx.sign(wrong))).rejects.toThrow();

    // A wrong signature costs a fresh round trip rather than unlimited attempts
    // against one live nonce — and this one hands out a session.
    await expect(
      signInWithWallet(fx.client, fx.address, fx.sign(challenge.message)),
    ).rejects.toMatchObject({ code: "CHALLENGE_USED" });
  });

  it("cannot be replayed after a successful sign-in", async () => {
    const fx = await setup();
    const challenge = await issueWalletSignInChallenge(fx.client, fx.address);
    const signature = fx.sign(challenge.message);

    await signInWithWallet(fx.client, fx.address, signature);

    await expect(signInWithWallet(fx.client, fx.address, signature)).rejects.toMatchObject({
      code: "CHALLENGE_USED",
    });
  });

  it("refuses a signature with no live challenge behind it", async () => {
    const fx = await setup();
    const message = buildWalletSignInMessage({ walletAddress: fx.address, nonce: "x" });

    /*
      `CHALLENGE_USED`, not `CHALLENGE_NOT_FOUND`, and the reason is worth
      knowing: **linking and signing in share one `wallet_challenges` row**,
      keyed `UNIQUE (user_id, address)`. The fixture linked this wallet, so the
      consumed link-challenge is still sitting there.

      That sharing is safe — the two messages carry different prefixes, so a
      live challenge for one purpose produces a signature the other rejects,
      which the replay test above pins. What it means is that
      `CHALLENGE_NOT_FOUND` is nearly unreachable for a wallet that has ever
      been linked, and a test asserting it would be asserting a state the
      application does not reach.
    */
    await expect(
      signInWithWallet(fx.client, fx.address, fx.sign(message)),
    ).rejects.toMatchObject({ code: "CHALLENGE_USED" });
  });

  it("refuses an expired challenge", async () => {
    const fx = await setup();
    const challenge = await issueWalletSignInChallenge(fx.client, fx.address);

    const later = new Date(challenge.expiresAt.getTime() + 1000);
    await expect(
      signInWithWallet(fx.client, fx.address, fx.sign(challenge.message), later),
    ).rejects.toMatchObject({ code: "CHALLENGE_EXPIRED" });
  });

  it("creates no account for an unknown wallet", async () => {
    const fx = await setup();
    const stranger = testWallet(11).address;
    const message = buildWalletSignInMessage({ walletAddress: stranger, nonce: "x" });

    await expect(signInWithWallet(fx.client, stranger, fx.sign(message))).rejects.toMatchObject(
      { code: "WALLET_NOT_LINKED" },
    );

    // Sign-up stays email-first. An account with no email has nothing an
    // invitation could reach.
    const [row] = await fx.client.query<{ n: number }>("SELECT count(*)::int AS n FROM users");
    expect(row?.n).toBe(1);
  });
});
