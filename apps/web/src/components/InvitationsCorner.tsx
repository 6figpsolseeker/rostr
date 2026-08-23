"use client";

import useSWR from "swr";

/**
 * Invitations waiting for you, in the corner.
 *
 * **This is the only consumer of `INVITATIONS_KEY`.** The comment here used to
 * describe it as one of two components deduplicating a shared SWR key — the
 * other was `InvitationBadge`, the count beside the nav's Leagues link, which
 * no longer exists. The header's bell counts a different thing from a different
 * route (`/api/me/notifications`), so nothing is being deduplicated and the
 * export is kept for the badge's return rather than for a sharer it has.
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
  const { data, mutate } = useSWR<PendingInvitation[]>(INVITATIONS_KEY, invitationsFetcher, {
    revalidateOnFocus: true,
  });

  /**
   * Refuse it.
   *
   * **The list is optimistic and revalidates**, because the alternative reads
   * as a dead button: the row is the only feedback there is, and waiting a
   * round trip to remove it invites a second click on an invitation that is
   * already gone.
   *
   * Not confirmed. A decline removes the invitation and tells the commissioner;
   * it does not bar anybody, and they can ask again — so a dialog here would be
   * guarding something reversible and would train people to click through the
   * ones that are not.
   */
  async function decline(invitationId: string): Promise<void> {
    await mutate(
      async (current) => {
        await fetch("/api/invitations", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ invitationId }),
        });
        return (current ?? []).filter((invitation) => invitation.id !== invitationId);
      },
      {
        optimisticData: (current: PendingInvitation[] | undefined) =>
          (current ?? []).filter((invitation) => invitation.id !== invitationId),
        rollbackOnError: true,
        revalidate: true,
      },
    );
  }

  const invitations = data ?? [];
  if (invitations.length === 0) return null;

  return (
    // Full width in the hub, where it is a section between your leagues and the
    // public list rather than a sidebar beside one. It was `lg:sticky lg:top-6`
    // when it sat in a column; sticky on a full-width band does nothing but
    // promise something the layout no longer has.
    <section
      className="space-y-3 rounded-lg border border-nocturne-accent/30 bg-nocturne-accent/5 p-4"
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

      <ul className="grid gap-2 sm:grid-cols-2">
        {invitations.slice(0, 4).map((invitation) => (
          <li key={invitation.id}>
            <div className="rounded border border-nocturne-neutral-900 bg-nocturne-bg/40 px-3 py-2 transition-colors hover:border-nocturne-neutral-800">
              <a href={`/leagues/${invitation.leagueId}`} className="block">
                <span className="block truncate text-sm">{invitation.leagueName}</span>
                <span className="block text-[11px] text-nocturne-neutral-600">
                  addressed to your{" "}
                  {invitation.addressedAs === "WALLET" ? "wallet address" : "username"}
                </span>
              </a>
              {/*
                A button, not a link, and outside the anchor — nesting an action
                inside a navigation target is how a decline becomes an accidental
                click on the way to reading the rules.
              */}
              <button
                onClick={() => void decline(invitation.id)}
                className="mt-1.5 text-[11px] text-nocturne-neutral-600 transition-colors hover:text-red-400"
              >
                Decline
              </button>
            </div>
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
    </section>
  );
}
