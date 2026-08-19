import { LeagueBrowser } from "@/components/LeagueBrowser";
import { currentUser } from "@/lib/session";

/**
 * Join a league.
 *
 * The other half of the front door — creating one has had a page since A10 and
 * joining one has never had anywhere to start. Until now a league was reachable
 * only by holding its URL, which is fine for the private leagues invitations
 * exist for and leaves a public league findable by nobody.
 *
 * Signing in is **not** required to look. `RULES.md` requires the full rule set
 * to be readable before anyone joins, and that argument does not begin at the
 * league page — somebody deciding whether this product is for them should be
 * able to see what is on offer first. The join control on the league page is
 * where an account becomes necessary, and it says so there.
 */
export default async function LeaguesPage() {
  const user = await currentUser().catch(() => null);

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Join a league</h1>
        <p className="max-w-2xl text-sm text-nocturne-neutral-400">
          Public leagues still taking managers. Every one shows you its whole rule set — the
          scoring, the roster, the draft, the payout — before you agree to anything, and those
          rules are frozen and hashed at creation, so what you read is what the season runs on.
        </p>
      </div>

      <LeagueBrowser />

      <section className="space-y-2 border-t border-nocturne-neutral-900 pt-6">
        <h2 className="text-sm font-medium text-nocturne-neutral-400">Been invited to one?</h2>
        <p className="text-sm text-nocturne-neutral-600">
          {user
            ? "Invitations to private leagues appear under Invitations, addressed to your username or your wallet."
            : "Sign in and any invitations waiting for you appear under Invitations — private leagues never show up in this list."}
        </p>
        <a
          href={user ? "/invitations" : "/signin?next=%2Finvitations"}
          className="inline-block text-sm text-nocturne-accent-300 hover:underline"
        >
          {user ? "See your invitations" : "Sign in"}
        </a>
      </section>
    </div>
  );
}
