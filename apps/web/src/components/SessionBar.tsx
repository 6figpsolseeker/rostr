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
export function SessionBar({
  email,
  /**
   * The name other people type to invite you, or null before it is claimed.
   *
   * Shown in preference to the email, because it is the identifier that means
   * anything to anyone else — and because a header is a screen-share away from
   * being public, which an email address should not be.
   */
  username,
}: {
  email: string | null;
  username: string | null;
}) {
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
      {username === null ? (
        // An account with no username cannot be invited to anything, so the
        // header says so and links to the fix rather than quietly showing an
        // email and leaving the person to discover it at the invite box.
        <a
          href="/welcome"
          className="text-nocturne-accent-300 transition-colors hover:text-nocturne-accent-200"
          title="Pick a username so people can invite you"
        >
          Finish setting up
        </a>
      ) : (
        <a
          href="/invitations"
          className="max-w-[16ch] truncate text-nocturne-neutral-400 transition-colors hover:text-nocturne-text"
          title={email ?? undefined}
        >
          {username}
        </a>
      )}
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
