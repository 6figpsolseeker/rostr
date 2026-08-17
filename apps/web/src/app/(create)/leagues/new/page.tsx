import { CreateLeagueForm } from "@/components/CreateLeagueForm";
import { currentUser } from "@/lib/session";

/**
 * Create a league.
 *
 * The header is the design's: the mark, the freeze state, and — once there is
 * one — the wallet. "Not yet frozen" is the whole point of the screen, so it is
 * chrome rather than a field.
 */
export default async function NewLeaguePage() {
  const user = await currentUser().catch(() => null);

  return (
    <>
      <header className="border-b border-nocturne-neutral-900">
        <div className="mx-auto flex w-full max-w-[1180px] items-center justify-between px-10 py-[14px]">
          <a href="/" className="text-[19px] font-semibold tracking-[-0.02em]">
            rostr
          </a>
          <div className="flex items-center gap-4">
            <span className="rounded-[4px] border border-nocturne-neutral-800 px-2 py-1 text-[11px] uppercase tracking-[0.12em] text-nocturne-neutral-500">
              Not yet frozen
            </span>
            {user?.email ? (
              <span className="text-[12.5px] text-nocturne-neutral-600">{user.email}</span>
            ) : null}
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1180px] px-10 py-12">
        {user ? (
          <CreateLeagueForm />
        ) : (
          <section className="max-w-[520px] rounded-lg bg-nocturne-surface p-7 shadow-[0_0_0_1px_#292b31]">
            <h1 className="text-[22px] font-medium tracking-[-0.02em]">Sign in first</h1>
            <p className="mt-3 text-[14.5px] leading-[1.62] text-nocturne-neutral-400">
              A league records who created it, and joining one later needs an account as well as
              a wallet.
            </p>
            <a
              href={`/signin?next=${encodeURIComponent("/leagues/new")}`}
              className="mt-6 inline-block rounded-[4px] border border-nocturne-accent px-[22px] py-3 text-[14.5px] text-nocturne-accent-200 transition-colors hover:bg-nocturne-accent/10"
            >
              Sign in
            </a>
          </section>
        )}
      </main>
    </>
  );
}
