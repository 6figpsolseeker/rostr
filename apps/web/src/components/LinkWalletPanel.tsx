"use client";

import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import bs58 from "bs58";

/**
 * Connect a wallet, and prove it is yours.
 *
 * Lifted out of `JoinPanel`, where this was the first third of a 600-line
 * component and reachable only from a league page — so the one thing every
 * account needs was behind a door you could only find by already having been
 * invited somewhere. `CLAUDE.md` names extracting it as the next slice of #165.
 *
 * **Typing an address would not do.** Anyone can type anyone's address; what
 * makes a wallet *yours* is a signature over a nonce the server issued, which is
 * why this is two round trips rather than a form field. The challenge is
 * consumed whether or not the signature checks out, so one nonce cannot absorb
 * unlimited attempts.
 *
 * It signs a message and never a transaction: no funds move, nothing is
 * approved, and the copy says so, because "sign this" is exactly the prompt
 * people have been trained to fear.
 */
export function LinkWalletPanel({
  /** Addresses this account has already proven. Rendered as done, not offered. */
  linked,
  onLinked,
  /** Shown above the button. The caller knows why it is asking. */
  children,
}: {
  linked: readonly string[];
  onLinked: (address: string) => void;
  children?: React.ReactNode;
}) {
  const { publicKey, signMessage, connected } = useWallet();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const address = publicKey?.toBase58() ?? null;
  const isLinked = address !== null && linked.includes(address);

  async function link(): Promise<void> {
    if (!address || !signMessage) return;
    setError(null);
    setBusy(true);

    try {
      const challengeResponse = await fetch("/api/auth/wallet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletAddress: address }),
      });
      const challenge = (await challengeResponse.json()) as {
        message?: string;
        error?: string;
      };
      if (!challengeResponse.ok || !challenge.message) {
        throw new Error(challenge.error ?? "Could not start wallet verification");
      }

      const signature = await signMessage(new TextEncoder().encode(challenge.message));

      const linkResponse = await fetch("/api/auth/wallet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletAddress: address, signature: bs58.encode(signature) }),
      });
      const body = (await linkResponse.json()) as { error?: string };
      if (!linkResponse.ok) throw new Error(body.error ?? "Could not verify this wallet");

      onLinked(address);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!connected) {
    return (
      <div className="space-y-3">
        {children}
        <WalletMultiButton />
      </div>
    );
  }

  if (isLinked) {
    return (
      <div className="space-y-1">
        <p className="text-sm text-nocturne-text/80">This wallet is verified.</p>
        <p className="font-mono text-xs break-all text-nocturne-neutral-600">{address}</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {children}
      <p className="font-mono text-xs break-all text-nocturne-neutral-600">{address}</p>
      <button
        onClick={() => void link()}
        disabled={busy}
        className="rounded-[4px] border border-nocturne-accent px-4 py-2 text-[13.5px] text-nocturne-accent-200 transition-colors hover:bg-nocturne-accent/10 disabled:opacity-40"
      >
        {busy ? "Waiting for your wallet…" : "Verify this wallet"}
      </button>
      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  );
}
