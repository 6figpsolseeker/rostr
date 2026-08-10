"use client";

import { useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { Transaction } from "@solana/web3.js";
import {
  escrowProgram,
  hexToBytes,
  joinLeagueIx,
  leaguePda,
  membershipPda,
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
 * take the client's word for it: `/join-onchain` reads the `Membership` PDA back
 * before recording, and derives the wallet from the caller's own consent row
 * rather than from anything sent here.
 *
 * ## The fifth step has to survive leaving the page
 *
 * The two halves are separate transactions with a wallet popup between them, so
 * "close the tab and come back later" is ordinary rather than exceptional.
 * `resumable` is resolved **server-side** from the consent row and the on-chain
 * record. If the step lived only in this component's `useState`, a reload would
 * strand the member with a db membership, no `Membership` account, and no
 * control anywhere that reaches one. It also has to render when the league is
 * full, because the member who took the final seat is exactly the one who most
 * needs it.
 *
 * ## Retrying must not re-send the transaction
 *
 * `join_league` uses `init`, so a second send fails with "account already in
 * use" — it is emphatically *not* idempotent. The signature is therefore held
 * in state once the transaction lands, and a retry re-POSTs that signature
 * instead of signing again. Otherwise the only recovery path from a dropped
 * response is the one path that cannot work.
 *
 * In-memory state alone is not enough, because a reload loses it and leaves the
 * same dead end. So the retry also asks the chain whether the `Membership`
 * account already exists and, if it does, recovers the transaction that created
 * it. Between them the two cover every way an attempt can be interrupted: the
 * account either does not exist (send it) or does (record what already
 * happened).
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
  resumable = false,
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
  /**
   * This user joined in Postgres but has no on-chain record yet, so the fifth
   * step is still owed. Server-resolved, so it survives a reload.
   */
  resumable?: boolean;
}) {
  const { connection } = useConnection();
  const { publicKey, signMessage, signTransaction, connected } = useWallet();
  const [linked, setLinked] = useState<readonly string[]>(linkedWallets);
  const [teamName, setTeamName] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [status, setStatus] = useState<
    "idle" | "loading" | "linking" | "signing" | "done" | "onchain" | "onchain-signing"
  >(resumable ? "onchain" : "idle");
  const [error, setError] = useState<string | null>(null);

  /**
   * The `join_league` signature, once the transaction has landed.
   *
   * Held so a failed POST can be retried without signing again — see the note
   * on retrying at the top of this file. `null` means nothing has been sent.
   */
  const [sentSignature, setSentSignature] = useState<string | null>(null);

  const address = publicKey?.toBase58() ?? null;
  const isLinked = address !== null && linked.includes(address);

  // A member who still owes the on-chain half keeps the panel even once the
  // league is full — the member who took the final seat is precisely the one
  // this would otherwise strand, since `open` counts their own team.
  if (!open && !resumable) {
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
      // Send only if we have not already. `join_league` is `init`, so a second
      // send fails with "account already in use" — re-signing would turn every
      // recoverable POST failure into a permanent dead end.
      let signature = sentSignature;

      // A reload loses `sentSignature`, so in-memory state is not enough: ask
      // the chain whether the account already exists. It does exactly when a
      // previous attempt landed and its POST did not, which is the case this
      // whole retry path exists for. Recovering the creating transaction is
      // what lets the audit record still name a real signature rather than
      // inventing one.
      if (signature === null) {
        const membership = membershipPda(leaguePda(leagueId), publicKey);
        if ((await connection.getAccountInfo(membership)) !== null) {
          const [creating] = await connection.getSignaturesForAddress(membership, { limit: 1 });
          if (!creating) {
            throw new Error(
              "Your membership account exists on-chain but the transaction that created " +
                "it could not be found. An archival RPC endpoint can still confirm it.",
            );
          }
          signature = creating.signature;
          setSentSignature(signature);
        }
      }

      if (signature === null) {
        const provider = new AnchorProvider(
          connection,
          { publicKey, signTransaction } as unknown as Wallet,
          { commitment: "confirmed" },
        );
        const program = escrowProgram(provider);

        const ix = await joinLeagueIx(program, {
          leagueId,
          rulesHash: hexToBytes(rulesHash),
          member: publicKey,
        });

        const tx = new Transaction().add(ix);
        signature = await provider.sendAndConfirm(tx, [], { commitment: "confirmed" });

        // Recorded before the POST, so a failure below retries the POST alone.
        setSentSignature(signature);
      }

      // No wallet address: the server reads it from this member's own consent
      // row. A body field would let anyone write anyone else's record.
      const response = await fetch(`/api/leagues/${leagueId}/join-onchain`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signature }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "The server could not verify the on-chain join");
      }

      setStatus("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      // Back to the on-chain step so the member can retry. If the transaction
      // already landed, `sentSignature` is set and the retry re-posts it rather
      // than signing again.
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
          {status === "done" ? (
            <div className="space-y-2 rounded border border-[--color-turf]/30 bg-[--color-turf]/5 p-4">
              <p className="text-sm text-white/80">
                Joined, on both sides. Your consent is recorded here and your{" "}
                <code className="font-mono text-xs">Membership</code> account exists on-chain.
              </p>
              <p className="text-xs text-white/40">Reload to see the league as a member.</p>
            </div>
          ) : status === "onchain" || status === "onchain-signing" ? (
            <div className="space-y-3 rounded border border-[--color-turf]/30 bg-[--color-turf]/5 p-4">
              <p className="text-sm text-white/80">
                You are in. One more step to make it real on-chain: sign{" "}
                <code className="font-mono text-xs">join_league</code> from your wallet so your
                membership account exists. Until you do, the program has no account to stake
                against.
              </p>
              {sentSignature !== null && (
                <p className="text-xs text-white/40">
                  Your transaction already landed — this will not ask your wallet again, it just
                  re-sends the confirmation to us.
                </p>
              )}
              <button
                onClick={() => void onchainJoin()}
                disabled={status === "onchain-signing"}
                className="rounded bg-[--color-turf] px-4 py-2 text-sm font-medium text-black disabled:opacity-40"
              >
                {status === "onchain-signing"
                  ? "Waiting…"
                  : sentSignature !== null
                    ? "Retry confirmation"
                    : "Confirm on-chain"}
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
                    // `"done"` is handled by its own branch above, so it cannot
                    // reach here — TypeScript narrows it away.
                    disabled={status === "signing"}
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
