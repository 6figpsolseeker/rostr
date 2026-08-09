"use client";

import { useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { PublicKey, Transaction } from "@solana/web3.js";
import { depositIx, escrowProgram, refundStakeIx } from "@rostr/escrow";
import { AnchorProvider, type Wallet } from "@coral-xyz/anchor";

/**
 * Staking into and out of a league's pot.
 *
 * **The member signs, not us.** There is no server keypair: `deposit` moves the
 * buy-in from the member's token account into the league vault, and `refund_stake`
 * moves it back after the timelock — both signed by the member's own wallet. So
 * this is a screen, like `AnchorPanel` and the on-chain half of `JoinPanel`, not
 * a background job.
 *
 * The server does not take the client's word for either: the `/deposit` and
 * `/refund` routes read the `Membership` PDA back (deposited > 0, refunded ==
 * true) before recording. A signature is an audit breadcrumb, not the proof.
 */
export function DepositPanel({
  leagueId,
  tokenMint,
  hasPot,
  refundUnlockAt,
}: {
  leagueId: string;
  /** The pot token mint (USDC). Required for a deposit. */
  tokenMint: string | null;
  /** Whether this league has a pot to stake into. */
  hasPot: boolean;
  /** Unix seconds after which a refund is permitted. */
  refundUnlockAt: number | null;
}) {
  const { connection } = useConnection();
  const { publicKey, signTransaction, connected } = useWallet();

  const [busy, setBusy] = useState<"deposit" | "refund" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<"deposit" | "refund" | null>(null);

  if (!hasPot || !tokenMint) {
    return (
      <section className="rounded border border-white/10 p-6">
        <p className="text-sm text-white/60">
          This league plays for pride, so there is nothing to stake.
        </p>
      </section>
    );
  }

  const refundOpen = refundUnlockAt !== null && Date.now() / 1000 >= refundUnlockAt;

  async function stake(): Promise<void> {
    if (!publicKey || !signTransaction) return;
    setBusy("deposit");
    setError(null);
    setDone(null);

    try {
      const provider = new AnchorProvider(connection, { publicKey, signTransaction } as unknown as Wallet, {
        commitment: "confirmed",
      });
      const program = escrowProgram(provider);

      const ix = await depositIx(program, {
        leagueId,
        mint: new PublicKey(tokenMint as string),
        member: publicKey,
      });

      const tx = new Transaction().add(ix);
      const signature = await provider.sendAndConfirm(tx, [], { commitment: "confirmed" });

      const response = await fetch(`/api/leagues/${leagueId}/deposit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletAddress: publicKey.toBase58(), signature }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "The server could not verify the deposit");
      }

      setDone("deposit");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function refund(): Promise<void> {
    if (!publicKey || !signTransaction) return;
    setBusy("refund");
    setError(null);
    setDone(null);

    try {
      const provider = new AnchorProvider(connection, { publicKey, signTransaction } as unknown as Wallet, {
        commitment: "confirmed",
      });
      const program = escrowProgram(provider);

      const ix = await refundStakeIx(program, {
        leagueId,
        mint: new PublicKey(tokenMint as string),
        member: publicKey,
      });

      const tx = new Transaction().add(ix);
      const signature = await provider.sendAndConfirm(tx, [], { commitment: "confirmed" });

      const response = await fetch(`/api/leagues/${leagueId}/refund`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletAddress: publicKey.toBase58(), signature }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "The server could not verify the refund");
      }

      setDone("refund");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="space-y-4 rounded border border-white/10 p-6">
      <h2 className="text-lg font-medium">Your stake</h2>
      <p className="text-sm text-white/60">
        Staking moves the buy-in from your wallet into the league vault. Refund is open once
        the timelock passes — and is unconditional, so your stake can never be stuck.
      </p>

      {!connected ? (
        <WalletMultiButton />
      ) : (
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => void stake()}
            disabled={busy !== null || done === "deposit"}
            className="rounded bg-[--color-turf] px-4 py-2 text-sm font-medium text-black disabled:opacity-50"
          >
            {busy === "deposit"
              ? "Waiting for the chain…"
              : done === "deposit"
                ? "Staked"
                : "Stake buy-in"}
          </button>

          <button
            type="button"
            onClick={() => void refund()}
            disabled={busy !== null || !refundOpen || done === "refund"}
            title={refundOpen ? undefined : "Refund unlocks after the timelock"}
            className="rounded border border-white/20 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            {busy === "refund"
              ? "Waiting for the chain…"
              : done === "refund"
                ? "Refunded"
                : "Refund stake"}
          </button>
        </div>
      )}

      {error && (
        <p className="rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      )}
    </section>
  );
}
