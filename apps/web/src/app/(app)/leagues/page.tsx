import { InvitationsCorner } from "@/components/InvitationsCorner";
import { LeagueBrowser } from "@/components/LeagueBrowser";
import { YourLeagues } from "@/components/YourLeagues";
import { invitationsForUser, leaguesForUser } from "@rostr/db";
import { db } from "@/lib/db";
import { hubView } from "@/lib/hub";
import { currentUser } from "@/lib/session";

/**
 * The Leagues hub — drop 8.
 *
 * One page ordered **your leagues → invitations → public leagues**, which is the
 * order a returning manager needs them in: the thing they came back for, the
 * thing waiting on them, then what to do if neither applies.
 *
 * It replaces a browse-only page that listed *public* leagues — by definition
 * the ones you are not in — so somebody with two leagues and an invitation had
 * no route to any of the three except browser history.
 *
 * ## Built to the design, minus what has no source
 *
 * Drop 8 marks its own parts as grounded or proposed and that line is honoured
 * here. The invitation count and the browse cards are grounded, and are the
 * shipped `InvitationsCorner` and `LeagueBrowser` rather than rebuilt.
 *
 * **The urgent strip, the notification bell and the account menu are drawn**,
 * and this paragraph used to say they were not. They were proposals with no
 * backing route when it was written; `notificationsForUser` is that route, so
 * the layout renders all three. Being on the clock also still rides on the
 * league's own card in `YourLeagues` — deliberate duplication, because a
 * 90-second clock must not live behind a click.
 *
 * **No join control anywhere on this page.** Both card types lead to the
 * league, where the whole rule set renders above the join button. `RULES.md`
 * requires the full document before anyone joins, and a join button in a
 * directory is a way to agree to a rule set nobody read.
 *
 * Signing in is not required to look: the browse list is public, and the two
 * signed-in sections render nothing for a visitor.
 */
export default async function LeaguesPage() {
  const user = await currentUser().catch(() => null);

  /*
    Counted on the server so the page can choose its own shape.

    `YourLeagues` and `InvitationsCorner` each self-fetch and render null when
    empty, which is right for them and leaves the page unable to tell an account
    with nothing from an account it has not loaded yet. A new user therefore got
    the returning manager's heading above two blank gaps and a directory that is
    usually empty as well — the first screen of the product, describing somebody
    else.

    The duplicate fetch is deliberate and cheap: both are indexed reads on one
    user id, and the alternative is threading server data through two client
    components that already know how to get it.
  */
  const [leagues, invitations] = user
    ? await Promise.all([
        leaguesForUser(db(), user.id).catch(() => []),
        invitationsForUser(db(), user.id).catch(() => []),
      ])
    : [[], []];

  const view = hubView({
    signedIn: user !== null,
    leagueCount: leagues.length,
    invitationCount: invitations.length,
  });

  return (
    <div className="space-y-10">
      {view === "EMPTY" ? (
        /*
          The brand-new account.

          Two cards of equal weight, because at this moment creating and being
          invited are the only two ways in and neither is the obvious one. The
          returning-manager head is wrong here in a way that is worse than plain:
          it describes leagues, invitations and a directory, and this person has
          none of the first two and usually sees none of the third.
        */
        <div className="space-y-6">
          <div className="space-y-2">
            <h1 className="text-2xl font-semibold tracking-tight">Leagues</h1>
            <p className="max-w-2xl text-sm text-nocturne-neutral-400">
              You are not in a league yet. Start one and invite people, or join one of the
              public leagues below — each shows its whole rule set before you agree to anything.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-3 rounded-lg border border-nocturne-accent/40 p-5">
              <h2 className="text-base font-medium">Create a league</h2>
              <p className="text-xs leading-[1.55] text-nocturne-neutral-500">
                You set the name, the draft time and the pace. Scoring, roster and payout are
                fixed, so there is no negotiating them mid-season — and you see all of it before
                it freezes.
              </p>
              <a
                href="/leagues/new"
                className="inline-block rounded-[4px] border border-nocturne-accent px-4 py-2 text-[13.5px] text-nocturne-accent-200 transition-colors hover:bg-nocturne-accent/10"
              >
                Create a league
              </a>
              <p className="text-[11px] text-nocturne-neutral-600">
                Free. Two humans is enough to start.
              </p>
            </div>

            {/*
              The second way in, which has no control because there is nothing
              to press. It exists to answer "where would an invitation even
              appear" before somebody concludes the answer is nowhere.
            */}
            <div className="space-y-3 rounded-lg border border-nocturne-neutral-900 p-5">
              <h2 className="text-base font-medium">Been invited to one?</h2>
              <p className="text-xs leading-[1.55] text-nocturne-neutral-500">
                Most leagues are private, so most are joined by invitation. Anything addressed
                to your username or your wallet appears here automatically — private leagues
                never show up in the public list.
              </p>
              <p className="text-[11px] text-nocturne-neutral-600">
                Nothing is waiting for you right now. If somebody sent you a link, opening it
                works too.
              </p>
            </div>
          </div>
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="space-y-2">
            <h1 className="text-2xl font-semibold tracking-tight">Leagues</h1>
            <p className="max-w-2xl text-sm text-nocturne-neutral-400">
              Your leagues, anything waiting on you, and every public league still taking
              managers. Each one shows its whole rule set before you agree to anything, and
              those rules are frozen and hashed at creation — so what you read is what the
              season runs on.
            </p>
          </div>

          {/*
            Create is a card with equal weight rather than a button in the nav.
            Drop 8's change, and it is right: starting a league and joining one
            are the same size of decision, and the nav made one an afterthought.
          */}
          <aside className="space-y-3 rounded-lg border border-nocturne-neutral-900 p-5">
            <h2 className="text-base font-medium">Start your own</h2>
            <p className="text-xs leading-[1.55] text-nocturne-neutral-500">
              Set the name, the draft time and the pace. Everything else is fixed, and you will
              see all of it before it freezes.
            </p>
            <a
              href="/leagues/new"
              className="inline-block rounded-[4px] border border-nocturne-accent px-4 py-2 text-[13.5px] text-nocturne-accent-200 transition-colors hover:bg-nocturne-accent/10"
            >
              Create a league
            </a>
            <p className="text-[11px] text-nocturne-neutral-600">
              Free. Two humans is enough to start — one bot squares an odd field.
            </p>
          </aside>
        </div>
      )}

      <YourLeagues />

      {/*
        Invitations sit between what you have and what is open, because that is
        where they belong in the decision: somebody asked for you specifically,
        which outranks a directory and does not outrank a draft already running.
      */}
      <InvitationsCorner />

      <section className="space-y-3">
        <header className="flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-medium tracking-wide text-nocturne-neutral-500 uppercase">
            Public leagues
          </h2>
          <span className="text-xs text-nocturne-neutral-600">still forming</span>
        </header>

        <LeagueBrowser />
      </section>

      {!user && (
        <p className="border-t border-nocturne-neutral-900 pt-6 text-sm text-nocturne-neutral-600">
          Private leagues never appear here — they arrive as an invitation or a link.{" "}
          <a
            href="/signin?next=%2Fleagues"
            className="text-nocturne-accent-300 hover:underline"
          >
            Sign in
          </a>{" "}
          to see yours and anything waiting on you.
        </p>
      )}
    </div>
  );
}
