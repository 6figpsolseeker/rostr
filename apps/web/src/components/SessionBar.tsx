"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Who you are, in the header.
 *
 * The user is resolved on the server and passed in, so the first paint is
 * already correct — a header that flashes "Sign in" before settling on your
 * email reads as if you had been signed out.
 */
export function SessionBar({ email }: { email: string | null }) {
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  if (!email) {
    return (
      <a
        href="/signin"
        className="text-[13.5px] text-nocturne-neutral-400 transition-colors hover:text-nocturne-text"
      >
        Sign in
      </a>
    );
  }

  async function signOut(): Promise<void> {
    setSigningOut(true);
    await fetch("/api/auth/session", { method: "DELETE" });
    router.refresh();
  }

  return (
    <div className="flex items-center gap-3 text-[13.5px]">
      <span className="max-w-[16ch] truncate text-nocturne-neutral-600" title={email}>
        {email}
      </span>
      <button
        onClick={() => void signOut()}
        disabled={signingOut}
        className="text-nocturne-neutral-400 transition-colors hover:text-nocturne-text disabled:opacity-40"
      >
        {signingOut ? "Signing out…" : "Sign out"}
      </button>
    </div>
  );
}
