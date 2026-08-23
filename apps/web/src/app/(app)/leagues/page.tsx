import { InvitationsCorner } from "@/components/InvitationsCorner";
import { LeagueBrowser } from "@/components/LeagueBrowser";
import { YourLeagues } from "@/components/YourLeagues";
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

  return (
    <div className="space-y-10">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">Leagues</h1>
          <p className="max-w-2xl text-sm text-nocturne-neutral-400">
            Your leagues, anything waiting on you, and every public league still taking
            managers. Each one shows its whole rule set before you agree to anything, and those
            rules are frozen and hashed at creation — so what you read is what the season runs
            on.
          </p>
        </div>

        {/*
          Create is a card with equal weight rather than a button in the nav.
          Drop 8's change, and it is right: starting a league and joining one are
          the same size of decision, and the nav made one of them an afterthought.
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
