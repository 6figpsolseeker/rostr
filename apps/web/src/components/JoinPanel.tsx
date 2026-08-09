"use client";

import { useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { PublicKey, Transaction } from "@solana/web3.js";
import {
  escrowProgram,
  hexToBytes,
  joinLeagueIx,
} from "@rostr/escrow";
import { AnchorProvider, type Wallet } from "@coral-xyz/anchor";
import bs58 from "bs58";

/**
 * The join flow.
 *
 * Four gates, in order, because each one genuinely depends on the last:
 *
 *   1. **Signed in.** The account being credited comes from the session cookie,
 *      never from anything this component sends.
 *   2. **Wallet connected.**
 *   3. **Wallet proven.** Signing a server-issued nonce. Without this, "linking
 *      a wallet" would be typing an address, and anyone could claim one —
 *      including one already holding a league stake.
 *   4. **Rules signed.** The message is fetched from the server and shown
 *      verbatim. A client that composed its own could sign one rule set and be
 *      admitted under another.
 *
 * And then a fifth step, the on-chain half (issue #26): after consent is
 * recorded in Postgres, the member signs `join_league` from their own wallet so
 * the program's `Membership` account exists. Without it, `deposit` and
 * `refund_stake` have no account to act on, and the on-chain member count — which
 * the program uses to refuse a full league — stays at zero. The server does not
 * take the client's word for it: the `/join-onchain` route reads the `Membership`
 * PDA back and checks it holds this member's key before recording anything.
 */
export function JoinPanel({
  leagueId,
  leagueName,
  rulesHash,
  open,
  signedIn,
  linkedWallets,
  anchored,
  isCommissioner,
}: {
  leagueId: string;
  leagueName: string;
  /** The league's rules hash (64 lower-case hex), as stored. */
  rulesHash: string;
  open: boolean;
  signedIn: boolean;
  linkedWallets: readonly string[];
  /** Whether the rules are on-chain yet. Joining is refused until they are. */
  anchored: boolean;
  isCommissioner: boolean;
}) {
  const { connection } = useConnection();
  const { publicKey, signMessage, signTransaction, connected } = useWallet();
  const [linked, setLinked] = useState<readonly string[]>(linkedWallets);
  const [teamName, setTeamName] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "linking" | "signing" | "done" | "onchain" | "onchain-signing">(
    "idle",
  );
  const [error, setError] = useState<string | null>(null);

  const address = publicKey?.toBase58() ?? null;
  const isLinked = address !== null && linked.includes(address);

  if (!open) {
    return (
      <section className="rounded border border-white/10 p-6">
        <p className="text-sm text-white/60">This league is not accepting members.</p>
      </section>
    );
  }

  if (!anchored) {
    // Refused server-side too — this is so the reason is legible rather than a
    // rejection out of nowhere.
    return (
      <section className="space-y-3 rounded border border-amber-500/30 bg-amber-500/5 p-6">
        <h2 className="text-lg font-medium">Not open yet</h2>
        <p className="text-sm text-white/70">
          These rules are not on-chain yet, so nobody can verify them — and nobody should agree
          to rules they cannot check. Until they are anchored, the only thing holding them still
          is this website&rsquo;s database, which is the arrangement this whole project exists
          to replace.
        </p>
        <p className="text-sm text-white/50">
          {isCommissioner
            ? "You created this league, so anchoring it is yours to do."
            : "The commissioner needs to anchor them before anyone joins."}
        </p>
      </section>
    );
  }

  if (!signedIn) {
    return (
      <section className="space-y-3 rounded border border-white/10 p-6">
        <h2 className="text-lg font-medium">Join {leagueName}</h2>
        <p className="text-sm text-white/60">
          Sign in first. Joining records who agreed to these rules, so it needs an account as
          well as a wallet.
        </p>
        <a
          href={`/signin?next=${encodeURIComponent(`/leagues/${leagueId}`)}`}
          className="inline-block rounded bg-[--color-turf] px-4 py-2 text-sm font-medium text-black"
        >
          Sign in
        </a>
      </section>
    );
  }

  /** Prove the connected wallet is ours, by signing a server-issued nonce. */
  async function linkWallet(): Promise<void> {
    if (!address || !signMessage) return;
    setError(null);
    setStatus("linking");

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

      setLinked([...linked, address]);
      setStatus("idle");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("idle");
    }
  }

  async function loadMessage(): Promise<void> {
    if (!address) return;
    setError(null);
    setStatus("loading");

    try {
      const response = await fetch(`/api/leagues/${leagueId}/join?wallet=${address}`);
      const body = (await response.json()) as { message?: string; error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not load the join message");

      setMessage(body.message ?? null);
      setStatus("idle");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("idle");
    }
  }

  async function join(): Promise<void> {
    if (!address || !signMessage || !message) return;
    setError(null);
    setStatus("signing");

    try {
      const signature = await signMessage(new TextEncoder().encode(message));

      const response = await fetch(`/api/leagues/${leagueId}/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          walletAddress: address,
          signature: bs58.encode(signature),
          teamName,
        }),
      });

      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Join failed");
      // Db-side consent is recorded. Next, the on-chain half: the member signs
      // `join_league` so the program's Membership account exists.
      setStatus("onchain");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("idle");
    }
  }

  /**
   * The on-chain half of joining (issue #26).
   *
   * The member signs `join_league` from their own wallet — no key of ours is
   * involved — and the server reads the Membership PDA back to confirm it before
   * recording anything. This is the same verify-don't-trust pattern the anchor
   * uses, applied one level down.
   */
  async function onchainJoin(): Promise<void> {
    if (!publicKey || !signTransaction || !address) return;
    setError(null);
    setStatus("onchain-signing");

    try {
      const provider = new AnchorProvider(connection, { publicKey, signTransaction } as unknown as Wallet, {
        commitment: "confirmed",
      });
      const program = escrowProgram(provider);

      const ix = await joinLeagueIx(program, {
        leagueId,
        rulesHash: hexToBytes(rulesHash),
        member: publicKey,
      });

      const tx = new Transaction().add(ix);
      const signature = await provider.sendAndConfirm(tx, [], { commitment: "confirmed" });

      const response = await fetch(`/api/leagues/${leagueId}/join-onchain`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletAddress: address, signature }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "The server could not verify the on-chain join");
      }

      setStatus("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      // Stay on the on-chain step so the member can retry; the db join already
      // happened, and re-signing join_league is idempotent (the PDA exists or
      // not — either way a replay is harmless).
      setStatus("onchain");
    }
  }

  return (
    <section className="space-y-4 rounded border border-white/10 p-6">
      <h2 className="text-lg font-medium">Join {leagueName}</h2>

      {!connected ? (
        <>
          <p className="text-sm text-white/60">
            Connect a wallet to sign these rules. Signing is what records your consent — there
            is no checkbox.
          </p>
          <WalletMultiButton />
        </>
      ) : !isLinked ? (
        <div className="space-y-3">
          <p className="text-sm text-white/60">
            Verify this wallet is yours by signing a one-time message. It moves no funds and
            approves no transaction.
          </p>
          <p className="font-mono text-xs break-all text-white/40">{address}</p>
          <button
            onClick={() => void linkWallet()}
            disabled={status === "linking"}
            className="rounded bg-[--color-turf] px-4 py-2 text-sm font-medium text-black disabled:opacity-40"
          >
            {status === "linking" ? "Waiting for your wallet…" : "Verify this wallet"}
          </button>
          {error && <p className="text-sm text-red-400">{error}</p>}
        </div>
      ) : (
        <div className="space-y-4">
          {status === "onchain" || status === "onchain-signing" ? (
            <div className="space-y-3 rounded border border-[--color-turf]/30 bg-[--color-turf]/5 p-4">
              <p className="text-sm text-white/80">
                You are in. One more step to make it real on-chain: sign{" "}
                <code className="font-mono text-xs">join_league</code> from your wallet so your
                membership account exists. Until you do, you cannot stake into the pot.
              </p>
              <button
                onClick={() => void onchainJoin()}
                disabled={status === "onchain-signing"}
                className="rounded bg-[--color-turf] px-4 py-2 text-sm font-medium text-black disabled:opacity-40"
              >
                {status === "onchain-signing" ? "Waiting for your wallet…" : "Confirm on-chain"}
              </button>
              {error && <p className="text-sm text-red-400">{error}</p>}
            </div>
          ) : (
            <>
              <label className="block text-sm">
                <span className="mb-1 block text-white/60">Team name</span>
                <input
                  value={teamName}
                  onChange={(e) => setTeamName(e.target.value)}
                  className="w-full rounded border border-white/15 bg-transparent px-3 py-2"
                  placeholder="Your team"
                />
              </label>

              {message === null ? (
                <button
                  onClick={() => void loadMessage()}
                  disabled={status === "loading" || teamName.trim() === ""}
                  className="rounded bg-[--color-turf] px-4 py-2 text-sm font-medium text-black disabled:opacity-40"
                >
                  {status === "loading" ? "Loading…" : "Review what you will sign"}
                </button>
              ) : (
                <>
                  <pre className="overflow-x-auto rounded border border-white/10 bg-black/40 p-4 text-xs whitespace-pre-wrap">
                    {message}
                  </pre>
                  <button
                    onClick={() => void join()}
                    disabled={status === "signing" || status === "done"}
                    className="rounded bg-[--color-turf] px-4 py-2 text-sm font-medium text-black disabled:opacity-40"
                  >
                    {status === "signing" ? "Waiting for your wallet…" : "Sign and join"}
                  </button>
                </>
              )}

              {error && <p className="text-sm text-red-400">{error}</p>}
            </>
          )}
        </div>
      )}
    </section>
  );
}
