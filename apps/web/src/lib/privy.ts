import "server-only";

/**
 * Verifying a Privy login, and nothing else Privy-shaped.
 *
 * Privy runs the login ceremony — the emailed code, and the Solana wallet it
 * generates for every account. rostr keeps its own users and its own session:
 * the browser hands over a Privy access token once, this checks it, and
 * `POST /api/auth/privy` mints the ordinary `rostr_session` cookie. So
 * `currentUser()` and everything behind it never learns Privy exists, and the
 * vendor stays in this one file.
 *
 * ## Two steps, and why the second is not optional
 *
 * **The token proves who.** It is a JWT signed by Privy for our app id, checked
 * locally — signature, issuer, audience, expiry — and its subject is the Privy
 * user id. It carries nothing else.
 *
 * **Privy's own record says what.** Email, wallets and X are read from
 * `users._get`, a call authenticated with our app secret. They are never taken
 * from the request, and never from Privy's identity token either: that token is
 * documented as possibly incomplete when a user has many linked accounts, and
 * it is minted at login — before the embedded wallet exists, on the first
 * sign-in of every new person.
 */

import { isEmbeddedWalletLinkedAccount, PrivyClient } from "@privy-io/node";
import type { LinkedAccount, User } from "@privy-io/node";
import type { VerifiedPrivyAccount } from "@rostr/db";

export class PrivyLoginError extends Error {
  constructor(
    message: string,
    readonly code:
      /** The token is missing, malformed, expired, or not for this app. */
      | "TOKEN_INVALID"
      /** The token was good and Privy could not be asked about the user. */
      | "PRIVY_UNAVAILABLE",
  ) {
    super(message);
    this.name = "PrivyLoginError";
  }
}

/** What the verifier needs from Privy — the SDK in production, a stub in tests. */
export interface PrivyApi {
  /** Resolves to the token's claims, or rejects when the token is not valid for this app. */
  verifyAccessToken(accessToken: string): Promise<{ readonly user_id: string }>;
  getUser(privyUserId: string): Promise<User>;
}

export interface PrivyLogin {
  verify(accessToken: string): Promise<VerifiedPrivyAccount>;
}

/**
 * The facts in a Privy user record that rostr acts on.
 *
 * **Only `type: "email"` counts as a verified email.** Privy links one of those
 * only after its holder has entered a code sent to it. An address inside an
 * OAuth profile — Google, Apple — is the provider's claim, and
 * `signInWithPrivy` attaches existing accounts by email, so treating that claim
 * as proof would let a provider account under somebody else's address sign in
 * as them.
 *
 * **Only wallets Privy generated count as embedded.** An external wallet a user
 * connects is a different fact with a different proof, and the product keeps it
 * as an "advanced" linked wallet rather than something sign-in records.
 */
export function accountFromPrivyUser(user: User): VerifiedPrivyAccount {
  const accounts: readonly LinkedAccount[] = user.linked_accounts;

  let verifiedEmail: string | null = null;
  const embeddedSolanaWallets: string[] = [];
  let x: VerifiedPrivyAccount["x"] = null;

  for (const account of accounts) {
    if (account.type === "email") {
      if (verifiedEmail === null && account.verified_at > 0 && account.address.trim() !== "") {
        verifiedEmail = account.address.trim();
      }
    } else if (isEmbeddedWalletLinkedAccount(account)) {
      // Privy's own definition of a wallet it generated, not a copy of it here.
      if (account.chain_type === "solana" && !embeddedSolanaWallets.includes(account.address)) {
        embeddedSolanaWallets.push(account.address);
      }
    } else if (account.type === "twitter_oauth") {
      x ??= { subject: account.subject, username: account.username };
    }
  }

  return { privyUserId: user.id, verifiedEmail, embeddedSolanaWallets, x };
}

export function createPrivyLogin(api: PrivyApi): PrivyLogin {
  return {
    async verify(accessToken) {
      if (accessToken.trim() === "") {
        throw new PrivyLoginError("A Privy access token is required", "TOKEN_INVALID");
      }

      let userId: string;
      try {
        ({ user_id: userId } = await api.verifyAccessToken(accessToken));
      } catch {
        // Every rejection reads the same: which check failed is of use to
        // somebody crafting tokens and to nobody signing in.
        throw new PrivyLoginError("That sign-in is not valid", "TOKEN_INVALID");
      }

      let user: User;
      try {
        user = await api.getUser(userId);
      } catch (error) {
        // A valid token for a user Privy no longer has is a deleted account,
        // not an outage — retrying will not help.
        if (hasStatus(error, 404)) {
          throw new PrivyLoginError("That sign-in is not valid", "TOKEN_INVALID");
        }
        throw new PrivyLoginError("Sign-in is unavailable right now", "PRIVY_UNAVAILABLE");
      }

      // The record must be the token's subject. A mismatch cannot happen through
      // the SDK and costs nothing to refuse.
      if (user.id !== userId) {
        throw new PrivyLoginError("That sign-in is not valid", "TOKEN_INVALID");
      }

      return accountFromPrivyUser(user);
    },
  };
}

function hasStatus(error: unknown, status: number): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status: unknown }).status === status
  );
}

let cached: { key: string; login: PrivyLogin } | undefined;

/**
 * The configured verifier, or `null` when Privy is not set up here.
 *
 * `PRIVY_APP_ID` and `PRIVY_APP_SECRET` are both required: the id is the
 * audience every token is checked against, and the secret is what reads the
 * user record. `PRIVY_VERIFICATION_KEY` is optional — given, tokens are checked
 * against it with no network call; unset, the SDK fetches and caches Privy's
 * published keys.
 */
export function privyLogin(): PrivyLogin | null {
  const appId = process.env["PRIVY_APP_ID"]?.trim();
  const appSecret = process.env["PRIVY_APP_SECRET"]?.trim();
  if (!appId || !appSecret) return null;
  // A PEM in an environment variable is usually pasted on one line with literal
  // "\n" between its lines, and a key with no real line breaks fails to import.
  const verificationKey = process.env["PRIVY_VERIFICATION_KEY"]?.trim().replaceAll("\\n", "\n");

  const key = `${appId}\n${appSecret}\n${verificationKey ?? ""}`;
  if (cached?.key === key) return cached.login;

  const client = new PrivyClient({
    appId,
    appSecret,
    ...(verificationKey ? { jwtVerificationKey: verificationKey } : {}),
    // A sign-in is a person waiting. One retry, then say so.
    timeout: 10_000,
    maxRetries: 1,
  });
  const login = createPrivyLogin({
    verifyAccessToken: (token) => client.utils().auth().verifyAccessToken(token),
    getUser: (id) => client.users()._get(id),
  });
  cached = { key, login };
  return login;
}
