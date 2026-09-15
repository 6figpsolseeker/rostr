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
import { usePrivySession } from "@/components/PrivyAuth";

/** A refusal from `POST /api/auth/privy`, in words that name the next action. */
const MESSAGES: Record<string, string> = {
  EMAIL_REQUIRED: "Sign in with an email address.",
  ACCOUNT_CONFLICT:
    "That email belongs to an account that signs in another way. Contact support.",
  WALLET_TAKEN: "Your wallet is linked to a different account. Contact support.",
  X_TAKEN: "That X account is linked to a different rostr account.",
  TOKEN_INVALID: "That sign-in did not go through. Try again.",
  PRIVY_UNAVAILABLE: "Sign-in is unavailable right now. Try again in a minute.",
  NOT_CONFIGURED: "Sign-in is not configured on this deployment.",
};

export function PrivySignIn({ next }: { next: string }) {
  const session = usePrivySession();

  useEffect(() => {
    if (session.status !== "signed-in") return;
    // An account is an email, a username and a wallet. Privy supplies the first
    // and the third; a missing username is asked for at `/welcome`, with `next`
    // carried through. A full navigation, because the session cookie was set by
    // a response the server component cache has not seen.
    window.location.href =
      session.gaps.length > 0 ? `/welcome?next=${encodeURIComponent(next)}` : next;
  }, [session.status, session.gaps, next]);

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

      {session.error && (
        <p className="text-sm text-amber-200">
          {MESSAGES[session.error.code] ?? session.error.message}
        </p>
      )}
    </div>
  );
}
