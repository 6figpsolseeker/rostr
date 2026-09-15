"use client";

import { useState } from "react";
import { usePrivySession } from "@/components/PrivyAuth";
import type { PrivyWalletStatus } from "@/lib/privy-wallet";

/**
 * What a league screen shows while the account's Privy wallet is not ready.
 *
 * Never an extension wallet's connect button: someone logged in to Privy has a
 * wallet coming, and offering Phantom in that gap is how a member was asked to
 * sign with the wrong wallet. Shared by `JoinPanel`, `AnchorPanel` and `/signin`,
 * in its own file so `/signin` does not load the join flow to render one line.
 *
 * `creating` offers to create the wallet, because Privy retries a failed or
 * interrupted creation only on a fresh login — without the button a person
 * whose creation failed would read "getting ready" forever.
 */
export function WalletPreparing({ status }: { status: PrivyWalletStatus }) {
  const privy = usePrivySession();
  const [asked, setAsked] = useState(false);

  if (status === "missing") {
    return (
      <p className="text-sm text-amber-200">
        Your wallet could not be loaded. Reload the page; if it is still missing, sign out and
        sign back in.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-sm text-nocturne-neutral-400">Getting your wallet ready…</p>
      {status === "creating" && (
        <button
          type="button"
          disabled={asked}
          onClick={() => {
            setAsked(true);
            void privy.createWallet().finally(() => setAsked(false));
          }}
          className="text-xs text-nocturne-accent-300 hover:underline disabled:opacity-40"
        >
          {asked ? "Creating…" : "Taking a while? Create my wallet"}
        </button>
      )}
    </div>
  );
}
