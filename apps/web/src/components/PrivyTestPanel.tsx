"use client";

/**
 * The controls behind `/dev/signin`, and nothing more. See that page.
 *
 * It shows two things side by side on purpose: what Privy thinks
 * (`usePrivySession`) and what rostr's own server thinks (`GET
 * /api/auth/session`). Sign-in has only worked when both agree.
 */

import { useCallback, useEffect, useState } from "react";
import { usePrivySession } from "@/components/PrivyAuth";

interface RostrSession {
  user: { id: string; email: string; displayName: string; emailVerified: boolean } | null;
  wallets: { address: string; isPrimary: boolean }[];
}

export function PrivyTestPanel() {
  const privy = usePrivySession();
  const [rostr, setRostr] = useState<RostrSession | null>(null);

  const refresh = useCallback(async () => {
    const response = await fetch("/api/auth/session", { cache: "no-store" });
    setRostr((await response.json()) as RostrSession);
  }, []);

  // Re-read rostr's session whenever the Privy side settles.
  useEffect(() => {
    void refresh();
  }, [privy.status, privy.xUsername, refresh]);

  const button =
    "rounded border border-nocturne-neutral-700 px-3 py-1.5 text-sm hover:bg-nocturne-neutral-900";

  return (
    <div className="space-y-6 text-sm">
      <section className="space-y-2">
        <h2 className="font-medium">Privy</h2>
        <pre className="overflow-x-auto rounded bg-nocturne-neutral-900 p-3 text-xs">
          {JSON.stringify(
            {
              status: privy.status,
              isNew: privy.isNew,
              gaps: privy.gaps,
              xUsername: privy.xUsername,
              walletStatus: privy.walletStatus,
              walletAddress: privy.wallet?.address ?? null,
              error: privy.error,
            },
            null,
            2,
          )}
        </pre>
        <div className="flex flex-wrap gap-2">
          <button className={button} onClick={() => privy.signIn()}>
            Sign in
          </button>
          <button className={button} onClick={() => privy.linkX()}>
            Link X
          </button>
          <button className={button} onClick={() => void privy.unlinkX()}>
            Unlink X
          </button>
          <button className={button} onClick={() => privy.retry()}>
            Retry
          </button>
          <button className={button} onClick={() => void privy.signOut()}>
            Sign out
          </button>
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="font-medium">rostr session</h2>
        <pre className="overflow-x-auto rounded bg-nocturne-neutral-900 p-3 text-xs">
          {JSON.stringify(rostr, null, 2)}
        </pre>
        <button className={button} onClick={() => void refresh()}>
          Refresh
        </button>
      </section>
    </div>
  );
}
