"use client";

import { useState } from "react";

/**
 * Sign in with a code that is typed, not a link that is followed.
 *
 * Two steps in one place: request a code, then enter it. The person never
 * leaves this page, and that is the whole design. A credential in a URL is
 * spent by whatever visits the URL — a Safe Browsing interstitial, a mail
 * scanner, an in-app browser with its own cookie jar — and each of those was
 * observed breaking sign-in on a live deployment.
 *
 * The response is the same whether or not the address has an account here, so
 * nothing below says "we found you" or "we created you".
 */
export function SignInForm({ next }: { next: string }) {
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [code, setCode] = useState("");
  const [stage, setStage] = useState<"email" | "code">("email");
  const [busy, setBusy] = useState(false);
  const [devCode, setDevCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * Read a JSON body without assuming there is one.
   *
   * No route can promise a body: an unhandled throw produces a 500 with nothing
   * at all, and calling `.json()` on that throws a `SyntaxError` whose message
   * — "Unexpected end of JSON input" — was once shown to users as though it
   * explained something. The status is the fact; the body is a courtesy.
   */
  async function readBody(response: Response): Promise<{ error?: string; devCode?: string }> {
    return ((await response.json().catch(() => null)) ?? {}) as {
      error?: string;
      devCode?: string;
    };
  }

  async function requestCode(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setBusy(true);

    try {
      const response = await fetch("/api/auth/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, displayName }),
      });
      const body = await readBody(response);

      if (!response.ok) {
        throw new Error(
          body.error ?? `Could not send the code (error ${response.status}). Please try again.`,
        );
      }

      setDevCode(body.devCode ?? null);
      setStage("code");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setBusy(true);

    try {
      const response = await fetch("/api/auth/code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, code }),
      });
      const body = await readBody(response);

      if (!response.ok) {
        throw new Error(body.error ?? `That did not work (error ${response.status}).`);
      }

      // A full navigation rather than a router push: the session cookie was set
      // on this response, and the destination is server-rendered against it.
      window.location.href = next;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  if (stage === "code") {
    return (
      <form onSubmit={(e) => void submitCode(e)} className="space-y-4">
        <p className="text-sm text-nocturne-neutral-400">
          If <span className="text-nocturne-text">{email}</span> can receive mail, a six-digit
          code is on its way. Enter it here — there is no link to click. It works once and
          expires in ten minutes.
        </p>

        {devCode && (
          <div className="space-y-1 rounded border border-amber-500/30 bg-amber-500/10 p-4">
            <p className="text-xs text-amber-200">
              No email provider is configured, so the code is shown here. Development only —
              this never appears in production.
            </p>
            <p className="font-mono text-lg tracking-[0.3em] text-amber-100">{devCode}</p>
          </div>
        )}

        <label className="block text-sm">
          <span className="mb-1 block text-nocturne-neutral-400">Sign-in code</span>
          <input
            // `inputMode` rather than `type="number"`: a numeric keypad on a
            // phone, without the spinners, and without a leading zero being
            // eaten by a number input.
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            required
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            className="w-40 rounded border border-nocturne-neutral-800 bg-transparent px-3 py-2 font-mono text-lg tracking-[0.3em]"
            placeholder="000000"
          />
        </label>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={busy || code.length !== 6}
            className="rounded-[4px] border border-nocturne-accent px-4 py-2 text-[13.5px] text-nocturne-accent-200 transition-colors hover:bg-nocturne-accent/10 disabled:opacity-40"
          >
            {busy ? "Checking…" : "Sign in"}
          </button>
          <button
            type="button"
            onClick={() => {
              setStage("email");
              setCode("");
              setError(null);
            }}
            className="text-xs text-nocturne-neutral-500 underline hover:text-nocturne-text"
          >
            Use a different address
          </button>
        </div>

        {error && <p className="text-sm text-red-400">{error}</p>}
      </form>
    );
  }

  return (
    <form onSubmit={(e) => void requestCode(e)} className="space-y-4">
      <label className="block text-sm">
        <span className="mb-1 block text-nocturne-neutral-400">Email</span>
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full rounded border border-nocturne-neutral-800 bg-transparent px-3 py-2"
          placeholder="you@example.com"
        />
      </label>

      <label className="block text-sm">
        <span className="mb-1 block text-nocturne-neutral-400">
          Display name <span className="text-nocturne-neutral-600">(optional)</span>
        </span>
        <input
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          className="w-full rounded border border-nocturne-neutral-800 bg-transparent px-3 py-2"
          placeholder="What league-mates see"
        />
      </label>

      <button
        type="submit"
        disabled={busy || email.trim() === ""}
        className="rounded-[4px] border border-nocturne-accent px-4 py-2 text-[13.5px] text-nocturne-accent-200 transition-colors hover:bg-nocturne-accent/10 disabled:opacity-40"
      >
        {busy ? "Sending…" : "Email me a code"}
      </button>

      {error && <p className="text-sm text-red-400">{error}</p>}
    </form>
  );
}
