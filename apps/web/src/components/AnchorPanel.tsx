"use client";

import { useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { PublicKey, Transaction } from "@solana/web3.js";
import {
  escrowProgram,
  hexToBytes,
  initializeFreeLeagueIx,
  initializeLeagueIx,
  payoutArray,
} from "@rostr/escrow";
import { AnchorProvider, type Wallet } from "@coral-xyz/anchor";

/**
 * Putting a league's rules on-chain.
 *
 * **The commissioner signs this, not us.** There is no server keypair anywhere
 * in the flow, which is why this is a screen rather than a background job: it
 * costs a signature and a little rent, and in exchange no private key of ours
 * exists to be funded, rotated, or lost.
 *
 * The consequence is that a league can sit unanchored — someone closes the tab
 * between creating and signing. That is deliberate and recoverable: nobody can
 * join until it is done, so the failure is visible rather than silent.
 *
 * Free leagues anchor too. The guarantee members are offered is that the rules
 * are fixed and checkable, and a guarantee that only covered leagues with money
 * in them would not be the one advertised.
 */

interface PotTerms {
  tokenMint: string;
  buyInBaseUnits: string;
  refundUnlockAt: number;
  payout: readonly { prize: string; basisPoints: number }[];
  feeBps: number;
  feeRecipient: string;
}

export function AnchorPanel({
  leagueId,
  rulesHash,
  maxTeams,
  pot,
}: {
  leagueId: string;
  /** The hash as stored: 64 lower-case hex characters. */
  rulesHash: string;
  maxTeams: number;
  pot: PotTerms | null;
}) {
  const { connection } = useConnection();
  const wallet = useWallet();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function anchor(): Promise<void> {
    if (!wallet.publicKey || !wallet.signTransaction) return;

    setBusy(true);
    setError(null);

    try {
      const provider = new AnchorProvider(connection, wallet as unknown as Wallet, {
        commitment: "confirmed",
      });
      const program = escrowProgram(provider);

      // The hash goes on-chain as raw bytes and comes out of Postgres as hex,
      // so this conversion is the one thing that must not be improvised.
      const hashBytes = hexToBytes(rulesHash);

      const ix = pot
        ? await initializeLeagueIx(program, {
            leagueId,
            rulesHash: hashBytes,
            mint: new PublicKey(pot.tokenMint),
            buyInBaseUnits: pot.buyInBaseUnits,
            refundUnlockAt: pot.refundUnlockAt,
            payoutBps: payoutArray(pot.payout),
            feeBps: pot.feeBps,
            // A fee-free league has no recipient — `FEE_RECIPIENT` unset means
            // leagues are created with `feeBps: 0` and an empty string, and
            // `new PublicKey("")` throws rather than yielding a default. The
            // program requires a recipient only when `fee_bps > 0`.
            feeRecipient: pot.feeRecipient
              ? new PublicKey(pot.feeRecipient)
              : PublicKey.default,
            maxTeams,
            payer: wallet.publicKey,
          })
        : await initializeFreeLeagueIx(program, {
            leagueId,
            rulesHash: hashBytes,
            maxTeams,
            payer: wallet.publicKey,
          });

      const tx = new Transaction().add(ix);
      const signature = await provider.sendAndConfirm(tx, [], {
        commitment: "confirmed",
      });

      // Tell the server, which does NOT take our word for it — it reads the
      // account back and checks the hash before recording anything.
      const response = await fetch(`/api/leagues/${leagueId}/anchor`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signature }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "The server could not verify the anchor");
      }

      setDone(true);
      // The join gate is rendered server-side, so the page has to come back to
      // reflect that this league is now open.
      window.location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return <p className="text-sm text-[--color-turf]">Anchored. Reloading…</p>;
  }

  return (
    <section className="space-y-4 rounded border border-white/10 p-6">
      <div className="space-y-1">
        <h2 className="text-lg font-medium">Anchor these rules on-chain</h2>
        <p className="text-sm text-white/60">
          Writes this league&rsquo;s rules hash to Solana, where anyone can check it against
          what they were shown. Until that exists, nobody can join.
        </p>
      </div>

      <dl className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-[auto_1fr]">
        <dt className="text-white/40">Rules hash</dt>
        <dd className="truncate font-mono text-white/70">{rulesHash}</dd>
        <dt className="text-white/40">Pot</dt>
        <dd className="text-white/70">
          {pot
            ? `${pot.buyInBaseUnits} base units per team`
            : "None — this league plays for pride"}
        </dd>
      </dl>

      <p className="text-xs text-white/40">
        You sign this from your own wallet and pay the rent — a fraction of a cent. No key of
        ours is involved at any point, which is the reason this is a button rather than
        something that already happened.
      </p>

      {!wallet.connected ? (
        <WalletMultiButton />
      ) : (
        <button
          type="button"
          onClick={() => void anchor()}
          disabled={busy}
          className="rounded bg-[--color-turf] px-4 py-2 text-sm font-medium text-black disabled:opacity-50"
        >
          {busy ? "Waiting for the chain…" : "Anchor on-chain"}
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
