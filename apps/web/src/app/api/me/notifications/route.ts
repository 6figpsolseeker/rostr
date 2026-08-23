import { NextResponse } from "next/server";
import { notificationsForUser } from "@rostr/db";
import { db } from "@/lib/db";
import { currentUser } from "@/lib/session";

/**
 * Everything waiting on you, across every league.
 *
 * Scoped to the session, like the rest of `/api/me`, and answering an empty list
 * for a signed-out caller rather than a 401 — the landing header asks on every
 * visit, and a 401 there would put an error in the console of every anonymous
 * page load.
 *
 * **Nothing is stored.** Each item is a query against the fact it describes, so
 * a trade that resolves stops appearing because it stopped being true. See
 * `notifications.ts` for why that beats a notifications table.
 */
export async function GET(): Promise<NextResponse> {
  const user = await currentUser();
  if (!user) return NextResponse.json({ notifications: [] });

  const items = await notificationsForUser(db(), user.id, new Date());

  return NextResponse.json({
    notifications: items.map((item) => ({
      kind: item.kind,
      leagueId: item.leagueId,
      leagueName: item.leagueName,
      href: item.href,
      text: item.text,
      deadline: item.deadline?.toISOString() ?? null,
      needsSignature: item.needsSignature,
    })),
  });
}
