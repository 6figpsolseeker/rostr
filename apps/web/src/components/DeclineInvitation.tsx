"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { mutate } from "swr";
import { INVITATIONS_KEY } from "@/components/InvitationsCorner";

/**
 * Refuse an invitation, from a server-rendered list.
 *
 * A client island rather than a form action because the page around it is a
 * server component and the row has to disappear without a full navigation —
 * `router.refresh()` re-runs the page's own query, which is the same list this
 * button just changed.
 *
 * **It also invalidates `INVITATIONS_KEY`**, and that is not incidental. The
 * header's corner reads the same invitations through SWR, so declining here
 * while leaving that cache alone would show the invitation gone from the page
 * and still present in the corner — the two disagreeing about the same fact on
 * the same screen.
 *
 * Not confirmed. A decline removes the invitation and tells the commissioner;
 * it does not bar anybody, and they can ask again — so a dialog would guard
 * something reversible and train people to click through the ones that are not.
 */
export function DeclineInvitation({ invitationId }: { invitationId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function decline(): Promise<void> {
    setBusy(true);
    try {
      await fetch("/api/invitations", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invitationId }),
      });
      await mutate(INVITATIONS_KEY);
      router.refresh();
    } finally {
      // Left busy on success would leave a dead control if the refresh is slow,
      // and the row is about to be removed either way.
      setBusy(false);
    }
  }

  return (
    <button
      onClick={() => void decline()}
      disabled={busy}
      className="text-xs text-nocturne-neutral-600 transition-colors hover:text-red-400 disabled:opacity-40"
    >
      {busy ? "Declining…" : "Decline"}
    </button>
  );
}
