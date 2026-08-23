"use client";

import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import bs58 from "bs58";

/**
 * Sign in with a wallet you have already linked.
 *
 * An emailed code is the right way to prove an account is yours the first time
 * and a poor way to do it the hundredth. A returning member already holds a key
 * this account has verified; sending them to a mail client for a weaker proof by
 * a slower route is the friction the owner asked to remove (2026-08-23).
 *
 * **It cannot create an account.** Sign-up stays email-first, so a wallet nobody
 * has linked gets told to sign in by email once — and after that, the wallet
 * alone is enough forever. The copy under the button says so, because otherwise
 * a returning member has no way to know they can stop checking their email.
 *
 * Offered beside the email form rather than instead of it. A wallet extension
 * that will not open, a new browser, a phone — email is the path that always
 * works, and burying it hides the recovery route at the moment it is needed.
 */
export function WalletSignIn({ next }: { next: string }) {
  const { publicKey, signMessage, connected } = useWallet();
  const { setVisible } = useWalletModal();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsEmail, setNeedsEmail] = useState(false);

  async function signIn(): Promise<void> {
    // Not connected yet: open the picker and stop. The person presses again
    // once a wallet is attached, which is one extra click and avoids guessing
    // which wallet they meant.
    if (!connected || !publicKey || !signMessage) {
      setVisible(true);
      return;
    }

    setBusy(true);
    setError(null);
    setNeedsEmail(false);

    try {
      const address = publicKey.toBase58();

      const challenge = await fetch("/api/auth/wallet-signin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address }),
      });
      const issued = (await challenge.json().catch(() => ({}))) as {
        message?: string;
        error?: string;
        code?: string;
      };

      if (!challenge.ok) {
        // The one refusal with a next step rather than an apology.
        if (issued.code === "WALLET_NOT_LINKED") {
          setNeedsEmail(true);
          return;
        }
        throw new Error(issued.error ?? "Could not start wallet sign-in");
      }

      // Signed exactly as issued. A client that composed its own message could
      // sign one thing and be credited with another, which is why the server
      // rebuilds it from the stored nonce and never trusts this text.
      const signature = await signMessage(new TextEncoder().encode(issued.message ?? ""));

      const verified = await fetch("/api/auth/wallet-signin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, signature: bs58.encode(signature) }),
      });
      const result = (await verified.json().catch(() => ({}))) as {
        error?: string;
        gaps?: { needsUsername?: boolean };
      };
      if (!verified.ok) throw new Error(result.error ?? "That signature was not accepted");

      // Same destination rule as the emailed-code form: an account still owing a
      // username goes to `/welcome` rather than to a page that would bounce it.
      window.location.href = result.gaps?.needsUsername ? "/welcome" : next;
    } catch (e) {
      // A rejected wallet prompt is a decision, not a failure. Saying "signature
      // rejected" to somebody who pressed Cancel reads as a bug in the app.
      const message = e instanceof Error ? e.message : String(e);
      setError(/reject|denied|cancel/i.test(message) ? null : message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => void signIn()}
        disabled={busy}
        className="w-full rounded-[4px] border border-nocturne-accent px-4 py-2.5 text-[14px] text-nocturne-accent-200 transition-colors hover:bg-nocturne-accent/10 disabled:opacity-40"
      >
        {busy ? "Waiting for your wallet…" : "Continue with wallet"}
      </button>

      <p className="text-[11.5px] leading-[1.5] text-nocturne-neutral-600">
        Returning? Connect the wallet you linked and you are in — no email, no code.
      </p>

      {needsEmail && (
        <p className="rounded border border-nocturne-accent/40 bg-nocturne-accent/5 px-3 py-2 text-[12px] text-nocturne-accent-100">
          This wallet is not linked to an account yet. Sign in with your email below once and
          link it — after that, the wallet on its own is enough.
        </p>
      )}

      {error && <p className="text-[12px] text-red-400">{error}</p>}
    </div>
  );
}
