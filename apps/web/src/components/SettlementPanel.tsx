"use client";

import { useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { PublicKey, Transaction } from "@solana/web3.js";
import { AnchorProvider, type Wallet } from "@coral-xyz/anchor";
import { escrowProgram, fetchOnChainScores, initializeScoresIx } from "@rostr/escrow";

/**
 * Writing the league's settlement account, once, before the season starts.
 *
 * ## Why there is a screen for this at all
 *
 * Nothing on-chain connects a team to a wallet. The escrow knows that a wallet
 * staked; that a wallet owns a particular team is a Postgres fact, and settlement
 * has to pay teams. So somebody attests the pairing, and the only question worth
 * arguing about is **when** — an attestation made at payout time cannot be
 * checked by anyone before the money is gone.
 *
 * This is that attestation, made months early, in public, and write-once. Every
 * member can check their own row for the rest of the season, and if it is wrong
 * the remedy is already built: nobody calls `start_season`, and every stake is
 * refundable 48 hours after the draft.
 *
 * ## The commissioner signs it, and chooses nothing
 *
 * Every value comes from `settlementPlan` on the server, derived from the frozen
 * rules and the roster that formed. `drawDraftOrder` then refuses to draw a
 * league whose account disagrees with those same rules — so this is a
 * transcription, and getting it wrong is caught rather than played out.
 *
 * They pay the rent and sign, for the same reason they do for the anchor: no key
 * of ours exists in the flow.
 */

export interface SettlementPanelProps {
  readonly leagueId: string;
  readonly roster: readonly { teamId: string; teamName: string; wallet: string }[];
  readonly oracle: string;
  readonly tiebreakers: readonly string[];
  readonly playoffWeeks: readonly number[];
  readonly regularSeasonWeeks: number;
  readonly playoffTeams: number;
  readonly firstRoundByes: number;
  readonly thirdPlace: boolean;
}

export function SettlementPanel(props: SettlementPanelProps) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function write(): Promise<void> {
    if (!wallet.publicKey) return;
    setBusy(true);
    setError(null);

    try {
      const provider = new AnchorProvider(connection, wallet as unknown as Wallet, {
        commitment: "confirmed",
      });
      const program = escrowProgram(provider);

      // Read before writing, like `JoinPanel` does. A commissioner whose
      // response was lost after the transaction confirmed presses again, and
      // `init` fails with "account already in use" — an error that means "you
      // already did this" and must not read as a failure.
      const existing = await fetchOnChainScores(program, props.leagueId);
      if (existing) {
        setDone(true);
        window.location.reload();
        return;
      }

      const ix = await initializeScoresIx(program, {
        leagueId: props.leagueId,
        commissioner: wallet.publicKey,
        roster: props.roster.map((entry) => ({
          teamId: entry.teamId,
          wallet: new PublicKey(entry.wallet),
        })),
        oracle: new PublicKey(props.oracle),
        tiebreakers: props.tiebreakers,
        playoffWeeks: props.playoffWeeks,
        regularSeasonWeeks: props.regularSeasonWeeks,
        playoffTeams: props.playoffTeams,
        firstRoundByes: props.firstRoundByes,
        thirdPlace: props.thirdPlace,
      });

      await provider.sendAndConfirm(new Transaction().add(ix), [], {
        commitment: "confirmed",
      });

      setDone(true);
      // The draw gate is evaluated server-side, so the page has to come back for
      // the lobby to stop asking for this.
      window.location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return <p className="text-sm text-nocturne-accent-300">Recorded. Reloading…</p>;
  }

  return (
    <section className="mb-8 space-y-4 rounded-lg border border-nocturne-accent/40 p-6">
      <div className="space-y-1">
        <h2 className="text-[15px] font-medium">Record who gets paid</h2>
        <p className="text-[13.5px] leading-[1.6] text-nocturne-neutral-400">
          Writes each team next to the wallet its prize would go to, along with the tiebreakers
          and playoff shape this league already agreed. It happens once and cannot be edited
          afterwards — the draft will not start without it.
        </p>
      </div>

      {/*
        Shown in full, not summarised. Every member can check their own row from
        now until January, and that check is the entire reason this is written
        months before it is worth anything. A collapsed list nobody opens would
        make the window real and unusable at the same time.
      */}
      <ul className="space-y-1 text-[13px]">
        {props.roster.map((entry) => (
          <li
            key={entry.teamId}
            className="flex justify-between gap-4 border-b border-nocturne-neutral-900 py-1.5"
          >
            <span className="text-nocturne-neutral-300">{entry.teamName}</span>
            <span className="truncate font-mono text-xs text-nocturne-neutral-500">
              {entry.wallet}
            </span>
          </li>
        ))}
      </ul>

      <p className="text-xs text-nocturne-neutral-600">
        If any row is wrong, do not start the season — every stake is returned 48 hours after
        the draft time, and nobody loses anything.
      </p>

      {!wallet.connected ? (
        <WalletMultiButton />
      ) : (
        <button
          type="button"
          onClick={() => void write()}
          disabled={busy}
          className="rounded-[4px] border border-nocturne-accent px-[18px] py-[10px] text-[13.5px] text-nocturne-accent transition-colors hover:bg-nocturne-accent/10 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "Waiting for the chain…" : "Record it on-chain"}
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
