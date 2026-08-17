"use client";

import { useState } from "react";

/**
 * Request a sign-in link.
 *
 * The response is the same whether or not the address has an account here — see
 * the API route. So the confirmation below deliberately does not say "we found
 * you" or "we created you".
 */
export function SignInForm({ next }: { next: string }) {
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent">("idle");
  const [devLink, setDevLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setStatus("sending");

    try {
      const response = await fetch("/api/auth/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, displayName, next }),
      });

      const body = (await response.json()) as { devLink?: string; error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not send the link");

      setDevLink(body.devLink ?? null);
      setStatus("sent");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("idle");
    }
  }

  if (status === "sent") {
    return (
      <div className="space-y-4 rounded border border-nocturne-neutral-900 p-6">
        <p className="text-sm">
          If <span className="text-nocturne-text">{email}</span> can receive mail, a sign-in
          link is on its way. It works once and expires in 24 hours.
        </p>

        {devLink && (
          <div className="space-y-2 rounded border border-amber-500/30 bg-amber-500/10 p-4">
            <p className="text-xs text-amber-200">
              No email provider is configured, so the link is shown here. Development only —
              this never appears in production.
            </p>
            <a
              href={devLink}
              className="block text-xs break-all text-nocturne-accent-300 underline"
            >
              {devLink}
            </a>
          </div>
        )}
      </div>
    );
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-4">
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
        disabled={status === "sending" || email.trim() === ""}
        className="rounded rounded-[4px] border border-nocturne-accent px-4 py-2 text-[13.5px] text-nocturne-accent-200 transition-colors hover:bg-nocturne-accent/10 disabled:opacity-40"
      >
        {status === "sending" ? "Sending…" : "Send sign-in link"}
      </button>

      {error && <p className="text-sm text-red-400">{error}</p>}
    </form>
  );
}
