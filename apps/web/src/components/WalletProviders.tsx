"use client";

import { useMemo } from "react";
import type { ReactNode } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import { CoinbaseWalletAdapter } from "@solana/wallet-adapter-coinbase";
import { clusterApiUrl } from "@solana/web3.js";

import "@solana/wallet-adapter-react-ui/styles.css";

/**
 * Wallet connection.
 *
 * Two mechanisms are in play, and it is worth knowing which does the work:
 *
 * 1. **Wallet Standard auto-registration.** Phantom, Solflare, Backpack, and
 *    Seed Vault on Seeker all announce themselves to the page. They appear in
 *    the modal with no adapter listed here at all — this is what covers most
 *    users, and what will cover wallets that do not exist yet.
 *
 * 2. **The explicit adapters below.** A fallback for wallets that do not
 *    announce themselves, or older builds that predate the standard. Coinbase
 *    is the one that genuinely needs it.
 *
 * `WalletProvider` deduplicates by wallet name, so a wallet that both registers
 * itself and appears here shows up once, not twice.
 *
 * Deliberately NOT using `@solana/wallet-adapter-wallets`, the meta-package that
 * bundles every adapter: it pulls in Ledger USB bindings, the Stellar SDK, and
 * protobufjs — roughly 500 packages — for wallets nobody here uses.
 */
export function WalletProviders({ children }: { children: ReactNode }) {
  const endpoint = useMemo(
    () => process.env["NEXT_PUBLIC_SOLANA_RPC_URL"] ?? clusterApiUrl("mainnet-beta"),
    [],
  );

  const wallets = useMemo(
    () => [
      new PhantomWalletAdapter(),
      new SolflareWalletAdapter(),
      new CoinbaseWalletAdapter(),
    ],
    [],
  );

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
