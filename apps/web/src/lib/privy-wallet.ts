/**
 * The pure half of signing with a Privy embedded wallet.
 *
 * Privy's Solana hooks take bytes and a chain name, while every panel in this
 * app builds `@solana/web3.js` transactions and signs through the wallet-adapter
 * shape. These two functions are the whole translation, kept out of the React
 * code because `apps/web` cannot render a component in a test.
 */

import { Transaction, VersionedTransaction } from "@solana/web3.js";
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
