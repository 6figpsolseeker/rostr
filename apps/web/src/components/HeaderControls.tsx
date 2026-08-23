"use client";

import { useEffect, useRef, useState } from "react";
import useSWR from "swr";

/**
 * The bell and the account menu — drop 9's header.
 *
 * One file because they are one control between them: **opening either closes
 * the other**, which the design asks for and which needs shared state to
 * guarantee rather than two components hoping.
 *
 * ## Both open on click
 *
 * The design left this open — hover on the landing page, click in the app — and
 * asked for a decision. It is **click, both places**, decided 2026-08-23:
 *
 * - Hover does not exist on touch, so a hover-open menu needs a click path
 *   anyway. Building click first means building one behaviour rather than two.
 * - A hover menu fires from a cursor merely passing through, which is the
 *   complaint the design already makes about a hover-open bell.
 * - One control should not behave differently depending on which page it is on.
 *
 * Keyboard reaches both, because they are buttons rather than hover targets —
 * the `focus` fallback the hover design needed is simply not required.
 *
 * ## The account row says Sign out
 *
 * The design says *Disconnect wallet*, on the premise that the wallet is the
 * account. It is not, in this app, and the owner confirmed keeping it that way
 * on 2026-08-23: sign-in is an emailed code and the wallet is linked afterwards
 * by signature. Disconnecting the adapter does not end a session and ending a
 * session does not disconnect the adapter, so a single row doing both would be
 * labelled untruthfully. Signing out does land on `/`, which the design is
 * right about.
 */

interface Notification {
  kind: string;
  leagueId: string;
  leagueName: string;
  href: string;
  text: string;
  deadline: string | null;
  needsSignature: boolean;
}

const fetcher = async (url: string): Promise<Notification[]> => {
  const response = await fetch(url);
  if (!response.ok) return [];
  const body = (await response.json()) as { notifications?: Notification[] };
  return body.notifications ?? [];
};

/** "1:12" or "3h" — the shape depends on how much is left. */
function remaining(deadline: string, now: number): string {
  const seconds = Math.max(0, Math.round((new Date(deadline).getTime() - now) / 1000));
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

interface Me {
  user: { username: string | null; email: string } | null;
}

const meFetcher = async (url: string): Promise<Me> => {
  const response = await fetch(url);
  if (!response.ok) return { user: null };
  return response.json() as Promise<Me>;
};

export function HeaderControls({
  username: givenUsername,
  email: givenEmail,
}: {
  /**
   * The account, when the caller already knows it.
   *
   * The signed-in layout resolves it on the server, so its first paint is right.
   * The landing page is statically prerendered and cannot — it passes nothing
   * and this asks. Two callers, one component, rather than two that drift.
   */
  username?: string | null;
  email?: string | null;
}) {
  const asks = givenEmail === undefined;
  const { data: me, isLoading } = useSWR<Me>(asks ? "/api/me" : null, meFetcher, {
    revalidateOnFocus: true,
  });

  const email = asks ? (me?.user?.email ?? null) : givenEmail;
  const username = asks ? (me?.user?.username ?? null) : (givenUsername ?? null);
  const [open, setOpen] = useState<"none" | "bell" | "account">("none");
  const [signingOut, setSigningOut] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);

  const { data } = useSWR<Notification[]>("/api/me/notifications", fetcher, {
    revalidateOnFocus: true,
    refreshInterval: 60_000,
  });
  const items = data ?? [];

  // A local tick, so a pick clock in the panel counts down between polls. Only
  // while something is actually counting.
  const [now, setNow] = useState(() => Date.now());
  const counting = items.some((item) => item.deadline !== null);
  useEffect(() => {
    if (!counting || open !== "bell") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [counting, open]);

  // Clicking away closes whichever is open, and Escape does the same. Both are
  // what people expect of a menu, and neither is worth discovering the hard way.
  useEffect(() => {
    if (open === "none") return;

    const onDown = (event: MouseEvent): void => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen("none");
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen("none");
    };

    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function signOut(): Promise<void> {
    setSigningOut(true);
    await fetch("/api/auth/session", { method: "DELETE" });
    // The design is right that this lands on the landing page: the app's other
    // screens all need a session, so staying put would mean an immediate bounce.
    window.location.href = "/";
  }

  if (asks && isLoading) {
    // Reserved space, no claim — see `LandingAccountLink`, which this replaces.
    return <span className="h-[22px] w-[104px]" aria-hidden />;
  }

  if (!email) {
    return (
      <a
        href="/welcome"
        className="flex items-center gap-2 text-[13px] text-nocturne-neutral-400 transition-colors hover:text-nocturne-text"
      >
        Connect wallet
      </a>
    );
  }

  return (
    <div ref={wrapper} className="relative flex items-center gap-3">
      {/*
        The bell exists only when connected. An anonymous visitor has no
        notifications, and an empty bell is furniture.
      */}
      <button
        onClick={() => setOpen(open === "bell" ? "none" : "bell")}
        aria-label={items.length === 1 ? "1 notification" : `${items.length} notifications`}
        aria-expanded={open === "bell"}
        className="relative text-nocturne-neutral-500 transition-colors hover:text-nocturne-text"
      >
        <svg viewBox="0 0 16 16" aria-hidden className="h-[17px] w-[17px] fill-current">
          <path d="M8 1a3.5 3.5 0 0 0-3.5 3.5v2.2c0 .5-.2 1-.5 1.4L3 9.6a.6.6 0 0 0 .5 1h9a.6.6 0 0 0 .5-1l-1-1.5a2.3 2.3 0 0 1-.5-1.4V4.5A3.5 3.5 0 0 0 8 1Zm0 13.5a2 2 0 0 0 2-2H6a2 2 0 0 0 2 2Z" />
        </svg>
        {items.length > 0 && (
          // A count, never a zero. A permanent badge is one people stop seeing.
          <span className="absolute -top-1.5 -right-1.5 grid h-[15px] min-w-[15px] place-items-center rounded-full bg-nocturne-accent px-1 text-[10px] font-semibold text-nocturne-bg">
            {items.length}
          </span>
        )}
      </button>

      <button
        onClick={() => setOpen(open === "account" ? "none" : "account")}
        aria-expanded={open === "account"}
        className="flex items-center gap-2 text-[13px] text-nocturne-neutral-400 transition-colors hover:text-nocturne-text"
      >
        <span
          className="grid h-[22px] w-[22px] place-items-center rounded-full bg-nocturne-accent/20 text-[10px] font-semibold text-nocturne-accent-200"
          aria-hidden
        >
          {(username ?? email).slice(0, 1).toUpperCase()}
        </span>
        <span className="max-w-[14ch] truncate">{username ?? "Finish setting up"}</span>
      </button>

      {open === "bell" && (
        <div className="absolute top-full right-0 z-50 mt-2 w-[24.5rem] max-w-[calc(100vw-2rem)] rounded-lg border border-nocturne-neutral-800 bg-nocturne-bg p-2 shadow-2xl">
          {items.length === 0 ? (
            <p className="px-3 py-4 text-[13px] text-nocturne-neutral-600">
              Nothing waiting on you.
            </p>
          ) : (
            <ul className="space-y-1">
              {items.map((item) => (
                <li key={`${item.kind}:${item.leagueId}`}>
                  <a
                    href={item.href}
                    className="block rounded px-3 py-2 transition-colors hover:bg-nocturne-surface/50"
                  >
                    <span className="flex items-baseline justify-between gap-3">
                      <span className="text-[13.5px]">{item.text}</span>
                      {item.deadline && (
                        <span className="shrink-0 text-[11px] tabular-nums text-nocturne-accent-300">
                          {remaining(item.deadline, now)}
                        </span>
                      )}
                    </span>
                    {item.needsSignature && (
                      // "This will ask for your wallet", before the click.
                      <span className="mt-0.5 block text-[11px] text-nocturne-neutral-600">
                        Signing required
                      </span>
                    )}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {open === "account" && (
        <div className="absolute top-full right-0 z-50 mt-2 w-[17rem] rounded-lg border border-nocturne-neutral-800 bg-nocturne-bg p-2 shadow-2xl">
          <p className="px-3 pt-2 pb-1 text-[11px] text-nocturne-neutral-600">{email}</p>

          {username === null && (
            // The shipped header's `username === null` branch, kept. An account
            // without one cannot be invited to anything and, since 2026-08-21,
            // cannot create or join either — so the menu leads with the fix.
            <a
              href="/welcome"
              className="block rounded px-3 py-2 text-[13.5px] text-nocturne-accent-300 hover:bg-nocturne-surface/50"
            >
              Finish setting up
            </a>
          )}

          <a
            href="/leagues"
            className="block rounded px-3 py-2 text-[13.5px] hover:bg-nocturne-surface/50"
          >
            Leagues
          </a>

          <button
            onClick={() => void signOut()}
            disabled={signingOut}
            className="block w-full rounded px-3 py-2 text-left text-[13.5px] text-nocturne-neutral-400 hover:bg-nocturne-surface/50 disabled:opacity-40"
          >
            {signingOut ? "Signing out…" : "Sign out"}
          </button>
        </div>
      )}
    </div>
  );
}
