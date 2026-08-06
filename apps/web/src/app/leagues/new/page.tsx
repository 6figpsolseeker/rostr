import { CreateLeagueForm } from "@/components/CreateLeagueForm";
import { currentUser } from "@/lib/session";

export default async function NewLeaguePage() {
  const user = await currentUser();

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Create a league</h1>
        <p className="max-w-2xl text-sm text-white/60">
          Everything you choose is frozen the moment the league is created. It cannot be amended
          afterwards except by unanimous signed consent of every member with a stake — so read
          the rules below before you commit, not after.
        </p>
      </header>

      {user ? (
        <CreateLeagueForm />
      ) : (
        <section className="space-y-3 rounded border border-white/10 p-6">
          <p className="text-sm text-white/60">
            Sign in first. A league records who created it, and joining it later needs an
            account as well as a wallet.
          </p>
          <a
            href={`/signin?next=${encodeURIComponent("/leagues/new")}`}
            className="inline-block rounded bg-[--color-turf] px-4 py-2 text-sm font-medium text-black"
          >
            Sign in
          </a>
        </section>
      )}
    </div>
  );
}
