"use client";

/**
 * The sign-in control on `/signin`: one button that opens Privy, and a
 * redirect once rostr's own session exists.
 *
 * Deliberately plain — the owner is designing the sign-in screens. What this
 * owns is the behaviour: where a signed-in person goes, and what a refusal
 * says. `next` arrives already passed through `safeRedirect` on the server.
 */

import { useEffect } from "react";
import { WalletPreparing } from "@/components/WalletPreparing";
import { usePrivySession } from "@/components/PrivyAuth";

/** A refusal from `POST /api/auth/privy`, in words that name the next action. */
const MESSAGES: Record<string, string> = {
  EMAIL_REQUIRED: "Sign in with an email address.",
  ACCOUNT_CONFLICT:
    "That email belongs to an account that signs in another way. Contact support.",
  WALLET_TAKEN: "Your wallet is linked to a different account. Contact support.",
  TOKEN_INVALID: "That sign-in did not go through. Try again.",
  PRIVY_UNAVAILABLE: "Sign-in is unavailable right now. Try again in a minute.",
  NOT_CONFIGURED: "Sign-in is not configured on this deployment.",
};

export function PrivySignIn({ next }: { next: string }) {
  const session = usePrivySession();

  // Wait for the wallet as well as the session. Privy creates a new person's
  // wallet only after login, and navigating away mid-creation both sent them to
  // `/welcome` to "connect a wallet" and could abort the creation. `missing` is
  // let through: it will not resolve by waiting, and `/welcome` can still finish.
  const walletSettled = session.walletStatus === "ready" || session.walletStatus === "missing";

  useEffect(() => {
    if (session.status !== "signed-in" || !walletSettled) return;
    // An account is an email, a username and a wallet. Privy supplies the first
    // and the third; a missing username is asked for at `/welcome`, with `next`
    // carried through. A full navigation, because the session cookie was set by
    // a response the server component cache has not seen.
    window.location.href =
      session.gaps.length > 0 ? `/welcome?next=${encodeURIComponent(next)}` : next;
  }, [session.status, session.gaps, walletSettled, next]);

  const busy = session.status === "loading" || session.status === "syncing";
  const unconfigured = session.error?.code === "NOT_CONFIGURED";

  return (
    <div className="space-y-3">
      <button
        onClick={() => (session.status === "error" ? session.retry() : session.signIn())}
        disabled={busy || unconfigured || session.status === "signed-in"}
        className="rounded bg-nocturne-accent px-4 py-2 text-sm font-medium text-nocturne-bg disabled:opacity-40"
      >
        {session.status === "syncing" || session.status === "signed-in"
          ? "Signing in…"
          : session.status === "error"
            ? "Try again"
            : "Sign in with email"}
      </button>

      {session.status === "signed-in" && !walletSettled && (
        // Not a bare "setting up" line: a failed creation stays `creating` until a
        // fresh login, so this page needs the same "Create my wallet" way out the
        // league screens have, or it waits forever (found in review, 2026-09-15).
        <WalletPreparing status={session.walletStatus} />
      )}

      {session.error && (
        <div className="space-y-2">
          <p className="text-sm text-amber-200">
            {MESSAGES[session.error.code] ?? session.error.message}
          </p>
          {!unconfigured && (
            // A refusal survives a reload — the Privy login is still there and is
            // exchanged again on every page — so retrying alone cannot get
            // someone out of, say, ACCOUNT_CONFLICT. Signing out of Privy can.
            <button
              type="button"
              onClick={() => void session.signOut()}
              className="text-xs text-nocturne-accent-300 hover:underline"
            >
              Use a different email
            </button>
          )}
        </div>
      )}
    </div>
  );
}
