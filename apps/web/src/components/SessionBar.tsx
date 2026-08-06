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
      <a href="/signin" className="text-sm text-white/70 hover:text-white">
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
    <div className="flex items-center gap-3 text-sm">
      <span className="max-w-[16ch] truncate text-white/50" title={email}>
        {email}
      </span>
      <button
        onClick={() => void signOut()}
        disabled={signingOut}
        className="text-white/70 hover:text-white disabled:opacity-40"
      >
        {signingOut ? "Signing out…" : "Sign out"}
      </button>
    </div>
  );
}
