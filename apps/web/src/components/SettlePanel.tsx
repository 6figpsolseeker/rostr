"use client";

import { useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { PublicKey, Transaction } from "@solana/web3.js";
import { escrowProgram, postFinalStandingsIx } from "@rostr/escrow";
import { AnchorProvider, type Wallet } from "@coral-xyz/anchor";

const PRIZE_LABELS = [
  "Champion",
  "Runner-up",
  "Regular season",
  "Consolation",
  "Third place",
] as const;

/**
 * The one trusted input to settlement (issue #28).
 *
 * The commissioner (the settle authority set at league creation) signs
 * `post_final_standings`, naming the five winners in prize order. This freezes
 * them on-chain; afterwards the program pays the vault out per the frozen split
 * with no further human in the loop. The route reads the `FinalStandings` PDA
 * back and records it.
 *
 * This is the honest seam: the winners are an off-chain decision (today, the
 * commissioner's score feed; tomorrow, an on-chain oracle). Everything downstream
 * — the fee, the split math, the per-winner membership checks, idempotency — is
 * enforced by the program.
 */
export function SettlePanel({
  leagueId,
  isCommissioner,
}: {
  leagueId: string;
  isCommissioner: boolean;
}) {
  const { connection } = useConnection();
  const { publicKey, signTransaction, connected } = useWallet();

  const [winners, setWinners] = useState<string[]>(Array(5).fill(""));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (!isCommissioner) return null;

  function setWinner(index: number, value: string): void {
    setWinners((prev) => prev.map((w, i) => (i === index ? value : w)));
  }

  const allFilled = winners.every((w) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(w.trim()));

  async function settle(): Promise<void> {
    if (!publicKey || !signTransaction || !allFilled) return;
    setBusy(true);
    setError(null);
    setDone(false);

    try {
      const provider = new AnchorProvider(
        connection,
        { publicKey, signTransaction } as unknown as Wallet,
        { commitment: "confirmed" },
      );
      const program = escrowProgram(provider);

      const ix = await postFinalStandingsIx(program, {
        leagueId,
        winners: winners.map((w) => new PublicKey(w.trim())),
        settleAuthority: publicKey,
      });

      const tx = new Transaction().add(ix);
      const signature = await provider.sendAndConfirm(tx, [], { commitment: "confirmed" });

      const response = await fetch(`/api/leagues/${leagueId}/settle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletAddress: publicKey.toBase58(), signature }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "The server could not verify the standings");
      }

      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-4 rounded border border-white/10 p-6">
      <h2 className="text-lg font-medium">Settle the league</h2>
      <p className="text-sm text-white/60">
        As commissioner you freeze the final standings on-chain. This names the five prize
        winners; the program then pays the pot out per the frozen split, with the protocol fee
        taken first. The winners are the one input that is not verified by the chain, so enter
        them carefully.
      </p>

      <ol className="space-y-2">
        {PRIZE_LABELS.map((label, i) => (
          <li key={label} className="flex items-center gap-3">
            <span className="w-32 text-sm text-white/70">{label}</span>
            <input
              type="text"
              value={winners[i]}
              onChange={(e) => setWinner(i, e.target.value)}
              placeholder="Wallet address"
              className="flex-1 rounded border border-white/15 bg-black/30 px-3 py-1.5 font-mono text-sm"
            />
          </li>
        ))}
      </ol>

      {!connected ? (
        <WalletMultiButton />
      ) : (
        <button
          type="button"
          onClick={() => void settle()}
          disabled={busy || !allFilled || done}
          className="rounded bg-[--color-turf] px-4 py-2 text-sm font-medium text-black disabled:opacity-50"
        >
          {busy ? "Waiting for the chain…" : done ? "Standings frozen" : "Freeze final standings"}
        </button>
      )}

      {error && (
        <p className="rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      )}
    </section>
  );
}
