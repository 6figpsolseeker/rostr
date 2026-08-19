"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
// The subpath, not the package root: `@rostr/db` reaches `identity.ts`, which
// imports `node:crypto`, and webpack cannot bundle that for a browser. The
// production build is what catches it — `tsc` is perfectly happy.
import { usernameProblem, usernameProblemMessage } from "@rostr/db/username-rules";
import { LinkWalletPanel } from "./LinkWalletPanel";
import { accountGaps } from "@/lib/account";

/**
 * The rest of signing up: a username, and a wallet.
 *
 * Both steps are shown at once rather than as a wizard, and the reason is the
 * same one that shaped the commissioner's checklist: **every step here is a row,
 * never a step counter**. Claiming a username is a round trip and linking a
 * wallet is a popup that steals focus, so leaving part-way through is the
 * ordinary case, not the exceptional one. State held in `useState` would strand
 * somebody exactly when the wallet extension took over the screen; state read
 * from what the server already knows survives a reload, a second tab, and the
 * popup.
 *
 * The username is validated by `usernameProblem` — the *same* function the
 * server calls. A client-side copy of those rules would drift, and then this
 * form would accept a name the API refuses.
 */
export function CompleteAccount({
  initialUsername,
  initialWallets,
  next,
}: {
  initialUsername: string | null;
  initialWallets: readonly string[];
  /** Where to go once both are done. Already checked by `safeRedirect`. */
  next: string;
}) {
  const router = useRouter();

  const [username, setUsername] = useState(initialUsername ?? "");
  const [savedUsername, setSavedUsername] = useState(initialUsername);
  const [wallets, setWallets] = useState<readonly string[]>(initialWallets);

  const [checking, setChecking] = useState(false);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const problem = username.trim() === "" ? null : usernameProblem(username);
  const gaps = accountGaps({ username: savedUsername, verifiedWallets: wallets.length });
  const done = gaps.length === 0;

  /**
   * Ask whether the name is free, a beat after they stop typing.
   *
   * Debounced because the alternative is a request per keystroke, and cancelled
   * on the way out because responses can arrive out of order — a slow answer for
   * "rou" landing after a fast one for "route66" would label a free name taken.
   */
  useEffect(() => {
    const name = username.trim();
    if (name === "" || usernameProblem(name) !== null || name === savedUsername) {
      setAvailable(null);
      return;
    }

    let cancelled = false;
    setChecking(true);

    const timer = setTimeout(() => {
      void (async () => {
        try {
          const response = await fetch(`/api/me/username?name=${encodeURIComponent(name)}`);
          const body = (await response.json()) as { available?: boolean };
          if (!cancelled) setAvailable(body.available ?? null);
        } catch {
          // A failed check says nothing. Claiming "taken" on a network blip
          // would send somebody away from a name that is theirs to have.
          if (!cancelled) setAvailable(null);
        } finally {
          if (!cancelled) setChecking(false);
        }
      })();
    }, 350);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [username, savedUsername]);

  async function claim(): Promise<void> {
    setSaving(true);
    setError(null);

    try {
      const response = await fetch("/api/me/username", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username }),
      });
      const body = (await response.json()) as { username?: string; error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not save that username");

      setSavedUsername(body.username ?? username);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <header className="flex items-baseline gap-3">
          <h2 className="text-lg font-medium">Pick a username</h2>
          {savedUsername && <span className="text-xs text-nocturne-accent-300">done</span>}
        </header>
        <p className="text-sm text-nocturne-neutral-400">
          This is how people invite you to a league — they type it, so it has to be something
          you can say out loud. Letters, numbers and underscores.
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="route66"
            spellCheck={false}
            autoComplete="off"
            className="w-56 rounded border border-nocturne-neutral-800 bg-transparent px-3 py-2 text-sm"
          />
          <button
            onClick={() => void claim()}
            disabled={
              saving || username.trim() === "" || problem !== null || available === false
            }
            className="rounded-[4px] border border-nocturne-accent px-4 py-2 text-[13.5px] text-nocturne-accent-200 transition-colors hover:bg-nocturne-accent/10 disabled:opacity-40"
          >
            {saving ? "Saving…" : savedUsername ? "Change it" : "Claim it"}
          </button>
        </div>

        <p className="min-h-[1.25rem] text-xs">
          {problem ? (
            <span className="text-amber-400">{usernameProblemMessage(problem)}</span>
          ) : checking ? (
            <span className="text-nocturne-neutral-600">Checking…</span>
          ) : available === false ? (
            <span className="text-red-400">Taken — try another.</span>
          ) : available === true ? (
            <span className="text-nocturne-accent-300">Free.</span>
          ) : savedUsername ? (
            <span className="text-nocturne-neutral-600">
              You are <span className="text-nocturne-text">{savedUsername}</span>.
            </span>
          ) : null}
        </p>

        {error && <p className="text-sm text-red-400">{error}</p>}
      </section>

      <section className="space-y-3 border-t border-nocturne-neutral-900 pt-8">
        <header className="flex items-baseline gap-3">
          <h2 className="text-lg font-medium">Connect a wallet</h2>
          {wallets.length > 0 && <span className="text-xs text-nocturne-accent-300">done</span>}
        </header>

        <LinkWalletPanel
          linked={wallets}
          onLinked={(address) => {
            setWallets([...wallets, address]);
            router.refresh();
          }}
        >
          <p className="text-sm text-nocturne-neutral-400">
            Your wallet is what signs your consent to a league&rsquo;s rules, and what a pot is
            paid out to. Verifying it signs a one-time message — it moves no funds and approves
            no transaction.
          </p>
        </LinkWalletPanel>
      </section>

      <section className="border-t border-nocturne-neutral-900 pt-8">
        {done ? (
          <a
            href={next}
            className="inline-block rounded-[4px] border border-nocturne-accent px-4 py-2 text-[13.5px] text-nocturne-accent-200 transition-colors hover:bg-nocturne-accent/10"
          >
            Continue
          </a>
        ) : (
          <p className="text-sm text-nocturne-neutral-600">
            {/*
              Names what is left rather than a count. "1 of 2 steps" tells
              somebody how far along they are and not what to do next.
            */}
            Still needed: {gaps.includes("USERNAME") ? "a username" : ""}
            {gaps.length === 2 ? " and " : ""}
            {gaps.includes("WALLET") ? "a verified wallet" : ""}.
          </p>
        )}
      </section>
    </div>
  );
}
