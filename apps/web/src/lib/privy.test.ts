/**
 * Verifying a Privy login.
 *
 * Two properties matter. **Nothing is believed that Privy's own record did not
 * say** — the token only names the user, and every fact comes from the record.
 * And **only a code-verified email and a Privy-generated wallet count**, because
 * `signInWithPrivy` attaches existing accounts by that email and marks that
 * wallet verified.
 *
 * Record shapes below follow `@privy-io/node`'s `LinkedAccount` types; the
 * `satisfies` checks fail typecheck if the SDK changes them.
 */

import { describe, expect, it } from "vitest";
import type { LinkedAccount, User } from "@privy-io/node";
import { accountFromPrivyUser, createPrivyLogin, PrivyLoginError } from "./privy";
import type { PrivyApi } from "./privy";

const SOLANA = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const OTHER_SOLANA = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

const email = {
  type: "email",
  address: "alice@example.com",
  verified_at: 1_757_000_000,
  first_verified_at: 1_757_000_000,
  latest_verified_at: 1_757_000_000,
} satisfies LinkedAccount;

const embeddedSolana = {
  type: "wallet",
  id: "wallet-1",
  address: SOLANA,
  chain_id: "solana:mainnet",
  chain_type: "solana",
  connector_type: "embedded",
  delegated: false,
  imported: false,
  public_key: SOLANA,
  recovery_method: "privy",
  verified_at: 1_757_000_001,
  first_verified_at: 1_757_000_001,
  latest_verified_at: 1_757_000_001,
  wallet_client: "privy",
  wallet_client_type: "privy",
  wallet_index: 0,
} satisfies LinkedAccount;

const externalSolana = {
  type: "wallet",
  address: OTHER_SOLANA,
  chain_type: "solana",
  connector_type: "solana_adapter",
  wallet_client: "unknown",
  wallet_client_type: "phantom",
  verified_at: 1_757_000_002,
  first_verified_at: 1_757_000_002,
  latest_verified_at: 1_757_000_002,
} satisfies LinkedAccount;

const embeddedEthereum = {
  ...embeddedSolana,
  id: "wallet-2",
  address: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
  chain_id: "eip155:1",
  chain_type: "ethereum",
} satisfies LinkedAccount;

const twitter = {
  type: "twitter_oauth",
  subject: "12345",
  username: "alice",
  name: "Alice",
  profile_picture_url: null,
  verified_at: 1_757_000_003,
  first_verified_at: 1_757_000_003,
  latest_verified_at: 1_757_000_003,
} satisfies LinkedAccount;

const google = {
  type: "google_oauth",
  subject: "google-1",
  email: "victim@example.com",
  name: "Not Alice",
  verified_at: 1_757_000_004,
  first_verified_at: 1_757_000_004,
  latest_verified_at: 1_757_000_004,
} satisfies LinkedAccount;

function user(linked: LinkedAccount[], id = "did:privy:alice"): User {
  return {
    id,
    created_at: 1_757_000_000,
    has_accepted_terms: false,
    is_guest: false,
    linked_accounts: linked,
    mfa_methods: [],
  };
}

describe("accountFromPrivyUser", () => {
  it("reads the verified email, the embedded Solana wallet and X", () => {
    expect(accountFromPrivyUser(user([email, embeddedSolana, twitter]))).toEqual({
      privyUserId: "did:privy:alice",
      verifiedEmail: "alice@example.com",
      embeddedSolanaWallets: [SOLANA],
      x: { subject: "12345", username: "alice" },
    });
  });

  it("never takes an email from an OAuth profile", () => {
    expect(accountFromPrivyUser(user([google])).verifiedEmail).toBeNull();
  });

  it("records only Solana wallets Privy generated", () => {
    expect(accountFromPrivyUser(user([externalSolana])).embeddedSolanaWallets).toEqual([]);
    expect(accountFromPrivyUser(user([embeddedEthereum])).embeddedSolanaWallets).toEqual([]);
  });

  it("reports absence as null and empty, so a stale X is cleared", () => {
    expect(accountFromPrivyUser(user([]))).toEqual({
      privyUserId: "did:privy:alice",
      verifiedEmail: null,
      embeddedSolanaWallets: [],
      x: null,
    });
  });
});

function api(overrides: Partial<PrivyApi> = {}): PrivyApi {
  return {
    verifyAccessToken: async () => ({ user_id: "did:privy:alice" }),
    getUser: async (id) => user([email, embeddedSolana], id),
    ...overrides,
  };
}

async function refusal(pending: Promise<unknown>): Promise<string> {
  const caught = await pending.then(
    () => null,
    (e: unknown) => e,
  );
  expect(caught).toBeInstanceOf(PrivyLoginError);
  return (caught as PrivyLoginError).code;
}

describe("createPrivyLogin", () => {
  it("reads the record of the token's own subject", async () => {
    const asked: string[] = [];
    const login = createPrivyLogin(
      api({
        getUser: async (id) => {
          asked.push(id);
          return user([email], id);
        },
      }),
    );

    const account = await login.verify("token");
    expect(asked).toEqual(["did:privy:alice"]);
    expect(account.privyUserId).toBe("did:privy:alice");
  });

  it("refuses a token that does not verify, without asking Privy about anyone", async () => {
    let asked = false;
    const login = createPrivyLogin(
      api({
        verifyAccessToken: async () => {
          throw new Error("JWTExpired");
        },
        getUser: async (id) => {
          asked = true;
          return user([email], id);
        },
      }),
    );

    expect(await refusal(login.verify("token"))).toBe("TOKEN_INVALID");
    expect(asked).toBe(false);
  });

  it("refuses a blank token", async () => {
    expect(await refusal(createPrivyLogin(api()).verify("  "))).toBe("TOKEN_INVALID");
  });

  it("refuses a record that is not the token's subject", async () => {
    const login = createPrivyLogin(
      api({ getUser: async () => user([email], "did:privy:bob") }),
    );
    expect(await refusal(login.verify("token"))).toBe("TOKEN_INVALID");
  });

  it("tells a deleted Privy user apart from Privy being down", async () => {
    const gone = createPrivyLogin(
      api({
        getUser: async () => {
          throw Object.assign(new Error("not found"), { status: 404 });
        },
      }),
    );
    const down = createPrivyLogin(
      api({
        getUser: async () => {
          throw Object.assign(new Error("bad gateway"), { status: 502 });
        },
      }),
    );

    expect(await refusal(gone.verify("token"))).toBe("TOKEN_INVALID");
    expect(await refusal(down.verify("token"))).toBe("PRIVY_UNAVAILABLE");
  });
});
