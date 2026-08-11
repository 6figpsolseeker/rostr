"use client";

import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  ConnectionProvider,
  useConnection,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import { CoinbaseWalletAdapter } from "@solana/wallet-adapter-coinbase";
import { clusterApiUrl } from "@solana/web3.js";
import {
  clusterFromGenesisHash,
  clusterMismatch,
  parseCluster,
  type Cluster,
} from "@rostr/escrow";

import "@solana/wallet-adapter-react-ui/styles.css";

/**
 * The chain this build was compiled for.
 *
 * `NEXT_PUBLIC_*` is inlined at build time, so this is a property of the
 * deployment rather than something a visitor can influence.
 *
 * **There is no mainnet fallback, and its absence is the point.** This used to
 * be `?? clusterApiUrl("mainnet-beta")`: a build with nothing configured pointed
 * every wallet at real money while the server verified against whatever
 * `SOLANA_RPC_URL` said. The commissioner's `initialize_league` landed on
 * mainnet, the server read devnet, found nothing, and returned `NOT_FOUND` —
 * which this route documents as "retry". Retrying cannot work, the account is
 * real, it cost mainnet rent, and the PDA derives from the league's UUID with no
 * `close`, so that league can never be anchored there again.
 *
 * Devnet is the fallback because it is the one that fails *visibly*: nothing
 * verifies, nobody loses anything, and the misconfiguration surfaces in minutes.
 */
const BUILD_CLUSTER: Cluster =
  parseCluster(process.env["NEXT_PUBLIC_SOLANA_CLUSTER"]) ?? "devnet";

/** `clusterApiUrl` has no localnet, so that one case is spelled out. */
function defaultEndpoint(cluster: Cluster): string {
  return cluster === "localnet" ? "http://127.0.0.1:8899" : clusterApiUrl(cluster);
}

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
    () => process.env["NEXT_PUBLIC_SOLANA_RPC_URL"] ?? defaultEndpoint(BUILD_CLUSTER),
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
        <WalletModalProvider>
          <ClusterBanner />
          {children}
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

/**
 * Asks the endpoint which chain it actually is, and says so when it disagrees
 * with the one this build was made for.
 *
 * `NEXT_PUBLIC_SOLANA_RPC_URL` overrides the cluster's default endpoint, so the
 * two can still disagree even with both set — a URL is a label somebody typed
 * and the genesis hash is the chain's own identity. This is the only place the
 * browser's chain is established as a fact rather than a convention, and the
 * browser is where the signing happens.
 *
 * **A banner, not a block.** It cannot disable a wallet — the adapter belongs to
 * the extension — and the server already refuses to record an anchor from the
 * wrong chain, so this is the warning rather than the enforcement. It is shown
 * unconditionally rather than only on pages with a sign button, because by the
 * time somebody reaches the anchor panel the mistake has already been made.
 *
 * A failed lookup says nothing. An unreachable RPC is its own visible problem
 * and does not mean the chain is wrong; claiming a mismatch on a network blip
 * would train people to dismiss the one that matters.
 */
function ClusterBanner() {
  const { connection } = useConnection();
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let live = true;

    connection
      .getGenesisHash()
      .then((hash) => {
        if (live) setMessage(clusterMismatch(BUILD_CLUSTER, clusterFromGenesisHash(hash)));
      })
      .catch(() => {});

    return () => {
      live = false;
    };
  }, [connection]);

  if (!message) return null;

  return (
    <div
      role="alert"
      className="border-b border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-200"
    >
      <strong className="font-semibold">Wrong network.</strong> {message}
    </div>
  );
}
