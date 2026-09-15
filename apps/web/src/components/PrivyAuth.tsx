"use client";

/**
 * Privy in the browser: the provider, and the hook that turns a Privy login
 * into a rostr session.
 *
 * **Plumbing, deliberately unstyled.** The owner is designing the sign-in
 * screens; nothing here renders anything but its children. A screen calls
 * `usePrivySession()` and gets `signIn`, `signOut`, `linkX` and the state of
 * the server exchange.
 *
 * **The exchange runs once, in the provider**, not in each component that asks.
 * Every consumer reads the same state, so a page with a header and a sign-in
 * form posts the token once rather than once per component.
 *
 * **Solana only, no EVM** (owner, 2026-09-13): `walletChainType` hides Ethereum
 * wallets and the Ethereum embedded wallet is never created. The SDK still ships
 * an Ethereum library inside it; that is a dependency of Privy's, and nothing in
 * this configuration turns it on.
 */

import { PrivyProvider, usePrivy } from "@privy-io/react-auth";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { AccountGap } from "@/lib/account";
import { privySyncKey } from "@/lib/privy-sync";

const APP_ID = process.env["NEXT_PUBLIC_PRIVY_APP_ID"]?.trim() ?? "";

export function PrivyAuthProvider({ children }: { children: ReactNode }) {
  // Unset, the app renders exactly as before rather than crashing every page:
  // the existing email-code sign-in keeps working until it is removed.
  if (APP_ID === "") return <>{children}</>;

  return (
    <PrivyProvider
      appId={APP_ID}
      config={{
        // Email is the only way in. The server attaches existing accounts by an
        // email Privy verified, and refuses a Privy account without one.
        loginMethods: ["email"],
        appearance: { walletChainType: "solana-only" },
        embeddedWallets: {
          ethereum: { createOnLogin: "off" },
          solana: { createOnLogin: "all-users" },
        },
      }}
    >
      <SessionExchange>{children}</SessionExchange>
    </PrivyProvider>
  );
}

export type PrivySessionStatus =
  /** Privy is still loading, or this build has no Privy app. */
  | "loading"
  | "signed-out"
  /** Logged in to Privy; the server exchange is in flight. */
  | "syncing"
  | "signed-in"
  | "error";

export interface PrivySession {
  readonly status: PrivySessionStatus;
  /** What the account still needs, as the server reported it. Empty until signed in. */
  readonly gaps: readonly AccountGap[];
  /** True on the sign-in that created the rostr account. */
  readonly isNew: boolean;
  /** The server's refusal code (`EMAIL_REQUIRED`, `ACCOUNT_CONFLICT`, …) or a network error. */
  readonly error: { readonly code: string; readonly message: string } | null;
  /** The X handle Privy has linked, or `null`. */
  readonly xUsername: string | null;
  signIn(): void;
  /** Post the current Privy login to the server again, after an `error`. */
  retry(): void;
  signOut(): Promise<void>;
  linkX(): void;
  unlinkX(): Promise<void>;
}

const NOT_CONFIGURED: PrivySession = {
  status: "loading",
  gaps: [],
  isNew: false,
  error: { code: "NOT_CONFIGURED", message: "Sign-in is not configured here" },
  xUsername: null,
  signIn: () => {},
  retry: () => {},
  // No Privy here, but there may still be a rostr session to end.
  signOut: async () => {
    await fetch("/api/auth/session", { method: "DELETE" }).catch(() => undefined);
  },
  linkX: () => {},
  unlinkX: async () => {},
};

const Session = createContext<PrivySession>(NOT_CONFIGURED);

/** The Privy sign-in state, shared by every component under the provider. */
export function usePrivySession(): PrivySession {
  return useContext(Session);
}

/** Runs inside `PrivyProvider`, where `usePrivy` is legal, and publishes the result. */
function SessionExchange({ children }: { children: ReactNode }) {
  return <Session.Provider value={useConfiguredSession()}>{children}</Session.Provider>;
}

interface ExchangeResult {
  readonly gaps: readonly AccountGap[];
  readonly isNew: boolean;
}

function useConfiguredSession(): PrivySession {
  const privy = usePrivy();
  const [exchange, setExchange] = useState<ExchangeResult | null>(null);
  const [error, setError] = useState<PrivySession["error"]>(null);
  const [syncing, setSyncing] = useState(false);
  const posted = useRef<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const key = privy.authenticated && privy.user ? privySyncKey(privy.user) : null;

  useEffect(() => {
    if (key === null) {
      posted.current = null;
      setExchange(null);
      return;
    }
    if (posted.current === key) return;
    posted.current = key;

    let cancelled = false;
    setSyncing(true);
    void (async () => {
      try {
        const token = await privy.getAccessToken();
        if (!token) throw new ExchangeError("TOKEN_INVALID", "Privy returned no access token");

        const response = await fetch("/api/auth/privy", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accessToken: token }),
        });
        const body = (await response.json().catch(() => ({}))) as {
          gaps?: AccountGap[];
          isNew?: boolean;
          error?: string;
          code?: string;
        };
        if (!response.ok) {
          throw new ExchangeError(
            body.code ?? `HTTP_${response.status}`,
            body.error ?? "Sign-in failed",
          );
        }
        if (!cancelled) {
          setExchange({ gaps: body.gaps ?? [], isNew: body.isNew === true });
          setError(null);
        }
      } catch (caught) {
        // Forget the key so a retry, the next change or a remount tries again —
        // unless a newer post has already replaced it.
        if (posted.current === key) posted.current = null;
        if (!cancelled) {
          setError(
            caught instanceof ExchangeError
              ? { code: caught.code, message: caught.message }
              : { code: "NETWORK", message: "Could not reach the server" },
          );
        }
      } finally {
        if (!cancelled) setSyncing(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // `privy` is a fresh object on every render; the key is what matters.
  }, [key, attempt]);

  const signOut = useCallback(async () => {
    // Our session first: a failed Privy logout must not leave a rostr session.
    await fetch("/api/auth/session", { method: "DELETE" }).catch(() => undefined);
    await privy.logout();
    posted.current = null;
    setExchange(null);
    setError(null);
  }, [privy]);

  const twitter = privy.user?.twitter ?? null;

  const status: PrivySessionStatus = !privy.ready
    ? "loading"
    : !privy.authenticated
      ? "signed-out"
      : error
        ? "error"
        : syncing || exchange === null
          ? "syncing"
          : "signed-in";

  return {
    status,
    gaps: exchange?.gaps ?? [],
    isNew: exchange?.isNew ?? false,
    error,
    xUsername: twitter?.username ?? null,
    signIn: () => privy.login(),
    retry: () => {
      posted.current = null;
      setError(null);
      setAttempt((n) => n + 1);
    },
    signOut,
    linkX: () => privy.linkTwitter(),
    unlinkX: async () => {
      if (twitter) await privy.unlinkTwitter(twitter.subject);
    },
  };
}

class ExchangeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
