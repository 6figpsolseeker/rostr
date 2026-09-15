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
 * **No fallback while someone is logged in to Privy.** The adapter auto-connects
 * Phantom in a browser that used it before, faster than Privy loads, and a
 * fallback taken in that gap asked a member to sign with Phantom instead of the
 * wallet their account was given. So while Privy's wallet is `loading` or
 * `missing` this answers "no wallet" with that status, and the panel says so.
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
import { signTransactionWithBytes, type PrivyWalletStatus } from "@/lib/privy-wallet";

export interface LeagueWallet {
  /** Which wallet is answering, or `null` when there is none to sign with. */
  readonly kind: "privy" | "extension" | null;
  /**
   * The Privy wallet's state when `kind` is not `privy`: `loading` and
   * `missing` mean a Privy wallet is expected and the panel should say so rather
   * than offer an extension. `none` means an extension is the right offer.
   */
  readonly privyStatus: PrivyWalletStatus;
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
  const privyStatus = privy.walletStatus;

  return useMemo<LeagueWallet>(() => {
    if (embedded) {
      return {
        kind: "privy",
        privyStatus,
        connected: true,
        address: embedded.address,
        publicKey: new PublicKey(embedded.address),
        signMessage: (message) => embedded.signMessage(message),
        signTransaction: (transaction) =>
          signTransactionWithBytes(transaction, (bytes) => embedded.signTransaction(bytes)),
      };
    }

    if (privyStatus === "loading" || privyStatus === "missing") {
      return {
        kind: null,
        privyStatus,
        connected: false,
        address: null,
        publicKey: null,
        signMessage: undefined,
        signTransaction: undefined,
      };
    }

    if (adapter.connected && adapter.publicKey) {
      return {
        kind: "extension",
        privyStatus,
        connected: true,
        address: adapter.publicKey.toBase58(),
        publicKey: adapter.publicKey,
        signMessage: adapter.signMessage,
        signTransaction: adapter.signTransaction,
      };
    }

    return {
      kind: null,
      privyStatus,
      connected: false,
      address: null,
      publicKey: null,
      signMessage: undefined,
      signTransaction: undefined,
    };
  }, [
    embedded,
    privyStatus,
    adapter.connected,
    adapter.publicKey,
    adapter.signMessage,
    adapter.signTransaction,
  ]);
}
