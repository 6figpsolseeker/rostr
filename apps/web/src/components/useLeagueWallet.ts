"use client";

/**
 * The wallet a league screen signs with.
 *
 * **The Privy wallet first, an extension wallet second.** Since 2026-09-14 every
 * account arrives with a Solana wallet Privy generated, and that is the one the
 * owner wants people to use: nothing to install, and the address is already
 * linked to the account at sign-in. A wallet connected through the adapter —
 * Phantom, Seed Vault — is the "advanced" path, used only when there is no Privy
 * wallet, which today means a build with no Privy app.
 *
 * Returns the same shape the panels already used from `useWallet()`, so a panel
 * changes one import and none of its signing logic: `AnchorProvider` takes
 * `{ publicKey, signTransaction }` either way.
 */

import { useMemo } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import type { Transaction, VersionedTransaction } from "@solana/web3.js";
import { usePrivySession } from "@/components/PrivyAuth";
import { signTransactionWithBytes } from "@/lib/privy-wallet";

export interface LeagueWallet {
  /** Which wallet is answering, or `null` when there is none to sign with. */
  readonly kind: "privy" | "extension" | null;
  readonly connected: boolean;
  readonly address: string | null;
  readonly publicKey: PublicKey | null;
  readonly signMessage: ((message: Uint8Array) => Promise<Uint8Array>) | undefined;
  readonly signTransaction:
    (<T extends Transaction | VersionedTransaction>(transaction: T) => Promise<T>) | undefined;
}

export function useLeagueWallet(): LeagueWallet {
  const privy = usePrivySession();
  const adapter = useWallet();
  const embedded = privy.wallet;

  return useMemo<LeagueWallet>(() => {
    if (embedded) {
      return {
        kind: "privy",
        connected: true,
        address: embedded.address,
        publicKey: new PublicKey(embedded.address),
        signMessage: (message) => embedded.signMessage(message),
        signTransaction: (transaction) =>
          signTransactionWithBytes(transaction, (bytes) => embedded.signTransaction(bytes)),
      };
    }

    if (adapter.connected && adapter.publicKey) {
      return {
        kind: "extension",
        connected: true,
        address: adapter.publicKey.toBase58(),
        publicKey: adapter.publicKey,
        signMessage: adapter.signMessage,
        signTransaction: adapter.signTransaction,
      };
    }

    return {
      kind: null,
      connected: false,
      address: null,
      publicKey: null,
      signMessage: undefined,
      signTransaction: undefined,
    };
  }, [
    embedded,
    adapter.connected,
    adapter.publicKey,
    adapter.signMessage,
    adapter.signTransaction,
  ]);
}
