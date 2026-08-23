import { redirect } from "next/navigation";
import { getWallets, invitationsForUser } from "@rostr/db";
import { db } from "@/lib/db";
import { accountGaps } from "@/lib/account";
import { currentUser } from "@/lib/session";
import { DeclineInvitation } from "@/components/DeclineInvitation";

/**
 * Leagues you have been asked to join.
 *
 * The counterpart to browsing: public leagues are findable, private ones are
 * not, and this is where a private league reaches somebody who was actually
 * invited to it. Every row here is a league whose commissioner deliberately
 * named this account.
 *
 * **Nothing here joins anything.** Each row links to the league page, where the
 * full rule set is rendered above the join control — `RULES.md` requires the
 * whole document to be shown before anyone joins, and an "accept" button in a
 * list would be a way to agree to a rule set nobody had read.
 */
export default async function InvitationsPage() {
  const user = await currentUser();
  if (!user) redirect("/signin?next=%2Finvitations");

  const client = db();
  const [invitations, wallets] = await Promise.all([
    invitationsForUser(client, user.id),
    getWallets(client, user.id),
  ]);

  const gaps = accountGaps({ username: user.username, verifiedWallets: wallets.length });

  return (
    <div className="max-w-2xl space-y-8">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Invitations</h1>
        <p className="text-sm text-nocturne-neutral-400">
          Leagues somebody asked you to join. Private leagues never appear in the public list,
          so this is where they reach you.
        </p>
      </div>

      {gaps.includes("USERNAME") && (
        // The commonest reason this list is empty is that nobody *can* invite
        // you: a commissioner types a username or an address, and an account
        // with neither is unreachable by either. Saying so here beats leaving
        // somebody to conclude their friends forgot.
        <p className="rounded border border-nocturne-accent/30 bg-nocturne-accent/5 px-4 py-3 text-sm">
          You have no username yet, so nobody can invite you by name.{" "}
          <a href="/welcome" className="text-nocturne-accent-300 hover:underline">
            Pick one
          </a>
          .
        </p>
      )}

      {invitations.length === 0 ? (
        <div className="space-y-3 rounded-lg border border-nocturne-neutral-900 p-6">
          <p className="text-sm text-nocturne-neutral-400">Nothing waiting.</p>
          <p className="text-sm text-nocturne-neutral-600">
            Give a commissioner your username
            {user.username && (
              <>
                {" "}
                — <span className="text-nocturne-text">{user.username}</span>
              </>
            )}{" "}
            or your wallet address, or look through the public leagues.
          </p>
          <a
            href="/leagues"
            className="inline-block rounded-[4px] border border-nocturne-accent px-4 py-2 text-[13.5px] text-nocturne-accent-200 transition-colors hover:bg-nocturne-accent/10"
          >
            Browse public leagues
          </a>
        </div>
      ) : (
        <ul className="space-y-3">
          {invitations.map((invitation) => (
            <li key={invitation.id}>
              <div className="space-y-2 rounded-lg border border-nocturne-neutral-900 p-5 transition-colors hover:border-nocturne-neutral-800">
                <a href={`/leagues/${invitation.leagueId}`} className="block space-y-2">
                  <div className="flex items-baseline justify-between gap-3">
                    <h2 className="truncate text-base font-medium">{invitation.leagueName}</h2>
                    <span className="shrink-0 text-xs text-nocturne-neutral-600">
                      {invitation.addressedAs === "WALLET"
                        ? "addressed to your wallet address"
                        : "addressed to your username"}
                    </span>
                  </div>
                  <p className="text-xs text-nocturne-neutral-600">
                    Read the rules and join &rarr;
                  </p>
                </a>
                {/*
                  Outside the anchor. An action nested inside a navigation target
                  is how declining becomes an accidental click on the way to
                  reading the rules.
                */}
                <DeclineInvitation invitationId={invitation.id} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
