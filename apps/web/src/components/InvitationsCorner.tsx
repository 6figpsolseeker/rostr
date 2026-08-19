"use client";

import useSWR from "swr";

/**
 * Invitations waiting for you, in the corner.
 *
 * Two components, **one request**: this and `InvitationBadge` share an SWR key,
 * so the header's count and the panel's list are the same fetch deduplicated
 * rather than two round trips that could disagree with each other for a second.
 *
 * The panel renders nothing at all when there is nothing waiting. An empty
 * "no invitations" card in the corner of every visit is furniture — the page
 * already says where invitations appear, in a place somebody reads once.
 */

export interface PendingInvitation {
  id: string;
  leagueId: string;
  leagueName: string;
  addressedAs: "USERNAME" | "WALLET";
  createdAt: string;
}

/** Shared so the badge and the panel cannot fetch twice or disagree. */
export const INVITATIONS_KEY = "/api/invitations";

export const invitationsFetcher = async (url: string): Promise<PendingInvitation[]> => {
  const response = await fetch(url);
  if (!response.ok) return [];
  const body = (await response.json()) as { invitations?: PendingInvitation[] };
  return body.invitations ?? [];
};

export function InvitationsCorner() {
  const { data } = useSWR<PendingInvitation[]>(INVITATIONS_KEY, invitationsFetcher, {
    revalidateOnFocus: true,
  });

  const invitations = data ?? [];
  if (invitations.length === 0) return null;

  return (
    <aside
      className="space-y-3 rounded-lg border border-nocturne-accent/30 bg-nocturne-accent/5 p-4 lg:sticky lg:top-6"
      aria-label="Invitations waiting for you"
    >
      <header className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium">
          {invitations.length === 1
            ? "You have an invitation"
            : `${invitations.length} invitations`}
        </h2>
        <a href="/invitations" className="text-xs text-nocturne-accent-300 hover:underline">
          All
        </a>
      </header>

      <p className="text-xs text-nocturne-neutral-500">
        {/*
          Says why it is here rather than in the list below. A private league is
          unlisted by design, so this corner is the only place it surfaces.
        */}
        Private leagues never appear in the list — this is where they reach you.
      </p>

      <ul className="space-y-2">
        {invitations.slice(0, 4).map((invitation) => (
          <li key={invitation.id}>
            <a
              href={`/leagues/${invitation.leagueId}`}
              className="block rounded border border-nocturne-neutral-900 bg-nocturne-bg/40 px-3 py-2 transition-colors hover:border-nocturne-neutral-800"
            >
              <span className="block truncate text-sm">{invitation.leagueName}</span>
              <span className="block text-[11px] text-nocturne-neutral-600">
                invited by {invitation.addressedAs === "WALLET" ? "wallet address" : "username"}
              </span>
            </a>
          </li>
        ))}
      </ul>

      {invitations.length > 4 && (
        <a
          href="/invitations"
          className="block text-xs text-nocturne-accent-300 hover:underline"
        >
          and {invitations.length - 4} more
        </a>
      )}
    </aside>
  );
}

/**
 * The count, for the header.
 *
 * Renders nothing when there is nothing waiting, rather than a zero. A badge
 * showing `0` is a permanent piece of chrome that teaches people to stop looking
 * at it, which is the opposite of what a notification is for.
 */
export function InvitationBadge() {
  const { data } = useSWR<PendingInvitation[]>(INVITATIONS_KEY, invitationsFetcher, {
    revalidateOnFocus: true,
  });

  const count = data?.length ?? 0;
  if (count === 0) return null;

  return (
    <a
      href="/invitations"
      className="inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-nocturne-accent px-1.5 py-0.5 text-[11px] font-semibold text-nocturne-bg transition-opacity hover:opacity-90"
      title={count === 1 ? "1 league has invited you" : `${count} leagues have invited you`}
      aria-label={count === 1 ? "1 invitation" : `${count} invitations`}
    >
      {count}
    </a>
  );
}
