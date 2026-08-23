"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";

/**
 * The one thing that cannot wait, under the header.
 *
 * Drop 9's argument, kept because it is the right one: **a 90-second draft clock
 * cannot live behind a click.** If a manager has to open a dropdown to learn
 * their pick is live, the dropdown failed. So the most pressing item is on the
 * page, and the bell holds it as well — nothing lives only in a place that
 * disappears.
 *
 * **One item, never a list.** A strip showing three things is a second
 * navigation bar; the bell is where everything lives. The one shown is the head
 * of `NOTIFICATION_URGENCY`, which the server already sorted.
 *
 * **It is empty almost always, and that is what makes it mean something.** A
 * strip that is always populated is a strip nobody reads — the same argument the
 * bell's badge makes for never rendering a zero.
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

/**
 * Which kinds are urgent enough to occupy the page.
 *
 * Not everything the bell holds belongs here. An invitation has no deadline and
 * an unset lineup is covered by the autofill; putting either in a strip would
 * make the strip permanent, and a permanent strip is furniture. What is left is
 * the set with a clock actually running.
 */
const URGENT = new Set(["ON_THE_CLOCK", "TRADE_AWAITING_YOU", "VETO_WINDOW", "DRAFT_SOON"]);

/** "0:47" under a minute, "3h 20m" above an hour — the precision that matters. */
function countdown(deadline: string, now: number): string {
  const seconds = Math.max(0, Math.round((new Date(deadline).getTime() - now) / 1000));
  if (seconds >= 3600) {
    const hours = Math.floor(seconds / 3600);
    return `${hours}h ${Math.floor((seconds % 3600) / 60)}m`;
  }
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function UrgentStrip() {
  const { data } = useSWR<Notification[]>("/api/me/notifications", fetcher, {
    revalidateOnFocus: true,
    // Shares its key with the bell, so the two are one request and cannot
    // disagree about what is most pressing.
    refreshInterval: 60_000,
  });

  const item = (data ?? []).find((entry) => URGENT.has(entry.kind));

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!item?.deadline) return;
    // A second, because the thing this exists for is a pick clock. The server
    // decides expiry; this is only the display.
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [item?.deadline]);

  if (!item) return null;

  return (
    <div className="border-b border-nocturne-accent/30 bg-nocturne-accent/10">
      <div className="mx-auto flex w-full max-w-[1180px] flex-wrap items-center gap-x-4 gap-y-1 px-10 py-2.5">
        <span className="text-[13.5px] font-medium text-nocturne-accent-100">{item.text}</span>

        {item.deadline && (
          <span className="text-[13.5px] tabular-nums text-nocturne-accent-200">
            {countdown(item.deadline, now)}
          </span>
        )}

        <a
          href={item.href}
          className="ml-auto text-[13px] text-nocturne-accent-200 underline-offset-2 hover:underline"
        >
          {item.kind === "ON_THE_CLOCK" ? "Go to the draft" : "Open"}
        </a>
      </div>
    </div>
  );
}
