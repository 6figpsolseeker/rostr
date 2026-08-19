"use client";

import useSWR from "swr";

/**
 * The account control in the marketing header.
 *
 * **Why this is a client component on an otherwise static page.** The landing
 * page is prerendered, and reading the session cookie on the server would make
 * the whole thing render per-request — a real cost on the one page that has to
 * load fast for people who have never heard of us. So the page stays static and
 * this one corner resolves after hydration.
 *
 * **It renders nothing until it knows**, rather than assuming signed out. A
 * header that says "Connect wallet" and then flips to your username reads as if
 * you had been signed out and quietly let back in — the same reason
 * `(app)/layout.tsx` resolves its user on the server rather than fetching. Here
 * the static requirement wins, so the compromise is to show no answer instead of
 * a wrong one, in a reserved space so the nav does not jump.
 *
 * ## What it fixes
 *
 * The header used to say "Connect wallet" unconditionally. Somebody who signed
 * in, claimed a username and verified a wallet was returned to this page and
 * shown exactly the same control as a stranger — which reads, correctly, as "it
 * did not keep my wallet and it does not think I am signed in". The wallet was
 * connected the whole time; `WalletProvider` has `autoConnect` and the adapter
 * persists its choice. Nothing on this page said so.
 */

interface Me {
  user: { username: string | null } | null;
  gaps: string[];
}

const fetcher = async (url: string): Promise<Me> => {
  const response = await fetch(url);
  if (!response.ok) return { user: null, gaps: [] };
  return response.json() as Promise<Me>;
};

const LINK =
  "flex items-center gap-2 text-[13px] text-nocturne-neutral-400 transition-colors hover:text-nocturne-text";

export function LandingAccountLink() {
  const { data, isLoading } = useSWR<Me>("/api/me", fetcher, {
    revalidateOnFocus: true,
  });

  // Reserved space, no claim. See the note above about flashing the wrong state.
  if (isLoading || !data) {
    return <span className="h-[19px] w-[104px]" aria-hidden />;
  }

  if (!data.user) {
    return (
      <a href="/welcome" className={LINK}>
        <WalletIcon />
        Connect wallet
      </a>
    );
  }

  // Signed in, but not finished — the username or the wallet is still missing,
  // and until both are there nobody can invite them to anything.
  if (data.gaps.length > 0) {
    return (
      <a href="/welcome" className={`${LINK} text-nocturne-accent-300`}>
        <WalletIcon />
        Finish setting up
      </a>
    );
  }

  return (
    <a href="/leagues" className={LINK} title="Your leagues and invitations">
      <span
        className="grid h-[22px] w-[22px] place-items-center rounded-full bg-nocturne-accent/20 text-[10px] font-semibold text-nocturne-accent-200"
        aria-hidden
      >
        {(data.user.username ?? "?").slice(0, 1).toUpperCase()}
      </span>
      <span className="max-w-[14ch] truncate">{data.user.username}</span>
    </a>
  );
}

function WalletIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="h-[15px] w-[15px] fill-current">
      <path d="M13 4H3a1 1 0 0 1 0-2h9.5a.5.5 0 0 0 0-1H3a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2Zm-1.5 6a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z" />
    </svg>
  );
}
