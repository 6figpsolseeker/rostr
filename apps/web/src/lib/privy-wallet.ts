/**
 * The pure half of signing with a Privy embedded wallet.
 *
 * Privy's Solana hooks take bytes and a chain name, while every panel in this
 * app builds `@solana/web3.js` transactions and signs through the wallet-adapter
 * shape. These two functions are the whole translation, kept out of the React
 * code because `apps/web` cannot render a component in a test.
 */

import { clusterApiUrl, Transaction, VersionedTransaction } from "@solana/web3.js";
import type { Cluster } from "@rostr/escrow";

/** The chain names Privy's Solana hooks accept. */
export type PrivySolanaChain = "solana:mainnet" | "solana:devnet" | "solana:testnet";

/**
 * The Privy chain for the cluster this build declares, or `null` for localnet.
 *
 * **Passed explicitly on every signature, never left to a default.** A
 * transaction's bytes do not say which cluster they are for, and the chain name
 * is how Privy decides where to simulate and what to show in its confirmation.
 * Guessing mainnet for a devnet build is the mistake `WalletProviders` already
 * documents at length for the adapter.
 *
 * Localnet has no Privy chain, so an embedded wallet cannot sign there; a local
 * validator is exercised with a keypair or an extension wallet instead.
 */
export function privyChain(cluster: Cluster): PrivySolanaChain | null {
  switch (cluster) {
    case "mainnet-beta":
      return "solana:mainnet";
    case "devnet":
      return "solana:devnet";
    case "testnet":
      return "solana:testnet";
    case "localnet":
      return null;
  }
}

/**
 * Sign a web3.js transaction with a signer that only speaks bytes.
 *
 * Serialised **without** requiring every signature, because the transaction is
 * by definition not yet signed by the key being asked; and deserialised as the
 * same kind it went in as, so `AnchorProvider.sendAndConfirm` gets back the
 * object type it passed. The returned transaction carries whatever signatures
 * the signer added, and nothing about it is trusted here — the cluster rejects
 * a bad signature, and every server route reads the result back from the chain.
 */
export async function signTransactionWithBytes<T extends Transaction | VersionedTransaction>(
  transaction: T,
  signBytes: (serialized: Uint8Array) => Promise<Uint8Array>,
): Promise<T> {
  if (transaction instanceof VersionedTransaction) {
    const signed = await signBytes(transaction.serialize());
    return VersionedTransaction.deserialize(signed) as T;
  }
  const serialized = transaction.serialize({
    requireAllSignatures: false,
    verifySignatures: false,
  });
  const signed = await signBytes(new Uint8Array(serialized));
  return Transaction.from(signed) as T;
}

/** The parts of a browser-side Privy linked account this reads. */
export interface PrivyLinkedAccountLike {
  readonly type: string;
  readonly address?: string | null;
  readonly chainType?: string;
  readonly walletClientType?: string;
  readonly connectorType?: string;
}

/**
 * The address of the Solana wallet Privy generated for this user, or `null`.
 *
 * The same test the server applies to Privy's record (`accountFromPrivyUser`):
 * a wallet Privy holds — client type `privy`, connector `embedded` — on Solana.
 * An external wallet linked through Privy, or an Ethereum one, is not it. The
 * first such wallet wins, matching the order the server records them in.
 */
export function embeddedSolanaAddress(user: {
  readonly linkedAccounts: readonly PrivyLinkedAccountLike[];
}): string | null {
  for (const account of user.linkedAccounts) {
    if (
      account.type === "wallet" &&
      account.chainType === "solana" &&
      account.walletClientType === "privy" &&
      account.connectorType === "embedded" &&
      typeof account.address === "string" &&
      account.address !== ""
    ) {
      return account.address;
    }
  }
  return null;
}

/**
 * The RPC endpoint the browser talks to: `NEXT_PUBLIC_SOLANA_RPC_URL` when set,
 * otherwise the cluster's public endpoint.
 *
 * **One definition for both signers.** The wallet adapter's `ConnectionProvider`
 * sends every transaction through this, and Privy simulates the transactions it
 * is asked to sign through its own configured RPC. Two separately-written
 * endpoints could name different chains for the same signature.
 *
 * An empty override counts as unset, rather than as an endpoint called "".
 */
export function browserRpcEndpoint(cluster: Cluster, override: string | undefined): string {
  const given = override?.trim();
  if (given) return given;
  // `clusterApiUrl` has no localnet, so that one case is spelled out.
  return cluster === "localnet" ? "http://127.0.0.1:8899" : clusterApiUrl(cluster);
}

/**
 * The websocket endpoint for an HTTP RPC endpoint.
 *
 * Privy's Solana hooks will not sign without subscriptions configured for the
 * chain ("No RPC configuration found for chain solana:devnet", seen 2026-09-15).
 * Public clusters and the common private providers serve both on the same host
 * and path, so swapping the scheme is enough; the query string, which carries a
 * private provider's API key, is kept.
 */
export function websocketEndpoint(httpEndpoint: string): string {
  const url = new URL(httpEndpoint);
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  return url.toString();
}

/**
 * The embedded wallet's state, as a screen should describe it.
 *
 * - `none` — nobody is logged in to Privy, so there is no wallet to wait for.
 * - `loading` — Privy, or its list of wallets, is still starting up.
 * - `creating` — Privy has loaded and this user has no embedded wallet yet. A new
 *   person's wallet is made a moment *after* login, so this is normally brief;
 *   but if that creation failed or was interrupted Privy only tries again on a
 *   fresh login, so a screen offers to create it rather than waiting forever.
 * - `ready` — it can sign.
 * - `missing` — Privy says it generated a wallet and it is not among the wallets
 *   Privy loaded. Waiting will not fix it, so it is reported.
 *
 * **Anything but `none` and `ready` is why a league screen never falls back to an
 * extension wallet while someone is logged in to Privy.** The adapter
 * auto-connects Phantom in a browser that used it before, faster than Privy
 * loads — a fallback taken in that gap asked a member to sign with Phantom in
 * place of the wallet their account was given (seen 2026-09-15).
 */
export type PrivyWalletStatus = "none" | "loading" | "creating" | "ready" | "missing";

export function privyWalletStatus(input: {
  readonly ready: boolean;
  readonly authenticated: boolean;
  readonly walletsReady: boolean;
  readonly embeddedAddress: string | null;
  readonly found: boolean;
}): PrivyWalletStatus {
  if (!input.ready) return "loading";
  if (!input.authenticated) return "none";
  if (input.found) return "ready";
  if (!input.walletsReady) return "loading";
  if (input.embeddedAddress === null) return "creating";
  return "missing";
}
