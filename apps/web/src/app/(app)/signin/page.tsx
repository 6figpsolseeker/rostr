import { PrivySignIn } from "@/components/PrivySignIn";
import { currentUser, safeRedirect } from "@/lib/session";

/**
 * Sign in, through Privy.
 *
 * One path for everyone: an email and a code, run by Privy, which also gives
 * every account a Solana wallet. The emailed-code and wallet sign-in routes this
 * page used to offer were removed on 2026-09-14 — see "Sign-in moves to Privy"
 * in `CLAUDE.md`.
 */
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const user = await currentUser();

  if (user) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">Already signed in</h1>
        <p className="text-sm text-nocturne-neutral-400">
          You are signed in as <span className="text-nocturne-text">{user.email}</span>.
        </p>
        <a href="/" className="inline-block text-sm text-nocturne-accent-300 hover:underline">
          Go to leagues
        </a>
      </div>
    );
  }

  return (
    <div className="max-w-md space-y-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
        <p className="text-sm text-nocturne-neutral-400">
          Your email and a one-time code. No password, and a wallet is created for you.
        </p>
      </div>

      <PrivySignIn next={safeRedirect(next ?? null)} />
    </div>
  );
}
