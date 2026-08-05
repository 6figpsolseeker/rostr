"use client";

import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import bs58 from "bs58";

/**
 * The join flow.
 *
 * Fetch the message from the server, show it verbatim, sign it, post the
 * signature. The client never composes the message — signing something the
 * server did not author would let a client sign one rule set and be admitted
 * under another.
 */
export function JoinPanel({
  leagueId,
  leagueName,
  open,
}: {
  leagueId: string;
  leagueName: string;
  open: boolean;
}) {
  const { publicKey, signMessage, connected } = useWallet();
  const [teamName, setTeamName] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "signing" | "done">("idle");
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <section className="rounded border border-white/10 p-6">
        <p className="text-sm text-white/60">This league is not accepting members.</p>
      </section>
    );
  }

  async function loadMessage(): Promise<void> {
    if (!publicKey) return;
    setError(null);
    setStatus("loading");
    try {
      const response = await fetch(
        `/api/leagues/${leagueId}/join?wallet=${publicKey.toBase58()}`,
      );
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
    if (!publicKey || !signMessage || !message) return;
    setError(null);
    setStatus("signing");
    try {
      const signature = await signMessage(new TextEncoder().encode(message));

      const response = await fetch(`/api/leagues/${leagueId}/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // TODO: userId comes from the session once auth is wired up (A9 UI).
          userId: "",
          walletAddress: publicKey.toBase58(),
          signature: bs58.encode(signature),
          teamName,
        }),
      });

      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Join failed");
      setStatus("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("idle");
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
      ) : (
        <div className="space-y-4">
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
                {status === "signing"
                  ? "Waiting for your wallet…"
                  : status === "done"
                    ? "Joined"
                    : "Sign and join"}
              </button>
            </>
          )}

          {error && <p className="text-sm text-red-400">{error}</p>}
        </div>
      )}
    </section>
  );
}
