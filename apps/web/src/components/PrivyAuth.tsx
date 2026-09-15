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
import { useSignMessage, useSignTransaction, useWallets } from "@privy-io/react-auth/solana";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { parseCluster } from "@rostr/escrow";
import type { AccountGap } from "@/lib/account";
import { privySyncKey } from "@/lib/privy-sync";
import { embeddedSolanaAddress, privyChain } from "@/lib/privy-wallet";

const APP_ID = process.env["NEXT_PUBLIC_PRIVY_APP_ID"]?.trim() ?? "";

/**
 * The Privy chain for this build, from the same declaration `WalletProviders`
 * reads — with the same devnet fallback, for the same reason given there.
 */
const CHAIN = privyChain(parseCluster(process.env["NEXT_PUBLIC_SOLANA_CLUSTER"]) ?? "devnet");

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

/** A Privy embedded wallet reduced to the two things this app asks of a wallet. */
export interface PrivyEmbeddedWallet {
  readonly address: string;
  /** Shows Privy's confirmation, then returns the ed25519 signature. */
  signMessage(message: Uint8Array): Promise<Uint8Array>;
  /** Signs serialised transaction bytes for this build's chain, without sending them. */
  signTransaction(serialized: Uint8Array): Promise<Uint8Array>;
}

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
  /**
   * The Solana wallet Privy generated for this user, ready to sign — or `null`
   * while signed out, while Privy is still creating it, or on a build with no
   * Privy app. Screens reach it through `useLeagueWallet`, not directly.
   */
  readonly wallet: PrivyEmbeddedWallet | null;
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
  wallet: null,
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

  // The embedded wallet, matched by address against what Privy's user record
  // says it generated — not "the first Solana wallet Privy can see", which
  // would include an external one connected through Privy's own modal.
  const { wallets: solanaWallets } = useWallets();
  const { signMessage } = useSignMessage();
  const { signTransaction } = useSignTransaction();
  const embeddedAddress =
    privy.authenticated && privy.user ? embeddedSolanaAddress(privy.user) : null;
  const connected = embeddedAddress
    ? (solanaWallets.find((candidate) => candidate.address === embeddedAddress) ?? null)
    : null;

  const wallet = useMemo<PrivyEmbeddedWallet | null>(() => {
    if (!connected) return null;
    return {
      address: connected.address,
      signMessage: async (message) =>
        (await signMessage({ message, wallet: connected })).signature,
      signTransaction: async (transaction) => {
        if (CHAIN === null) {
          throw new Error(
            "A Privy wallet cannot sign on a local validator. Use a keypair or an extension wallet there.",
          );
        }
        return (await signTransaction({ transaction, wallet: connected, chain: CHAIN }))
          .signedTransaction;
      },
    };
  }, [connected, signMessage, signTransaction]);

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
    wallet,
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
