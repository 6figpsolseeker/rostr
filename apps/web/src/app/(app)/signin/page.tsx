import { SignInForm } from "@/components/SignInForm";
import { WalletSignIn } from "@/components/WalletSignIn";
import { currentUser } from "@/lib/session";

const MESSAGES: Record<string, string> = {
  expired: "That link has expired. Request a new one below.",
  invalid: "That link is not valid. It may already have been used.",
  missing: "That link was incomplete. Request a new one below.",
};

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const { error, next } = await searchParams;
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
          Two ways in, and no password to forget or leak. If you have linked a wallet before,
          that is the quick one.
        </p>
      </div>

      {error && MESSAGES[error] && (
        <p className="rounded border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          {MESSAGES[error]}
        </p>
      )}

      {/*
        Wallet first in the reading order, email second, neither buried.

        A returning member takes the top path and never opens their mail; anyone
        on a new browser, a phone, or a wallet extension that will not load
        takes the bottom one. Hiding email behind a link would put the recovery
        route out of sight at exactly the moment it is needed — the same reason
        the cluster banner warns rather than blocks.
      */}
      <WalletSignIn next={next ?? "/"} />

      <div className="flex items-center gap-3" aria-hidden>
        <span className="h-px flex-1 bg-nocturne-neutral-900" />
        <span className="text-[11px] text-nocturne-neutral-600">or</span>
        <span className="h-px flex-1 bg-nocturne-neutral-900" />
      </div>

      <SignInForm next={next ?? "/"} />

      <p className="text-xs text-nocturne-neutral-600">
        You will link a wallet after signing in. Email is how we reach you; the wallet is what
        signs your consent to a league&rsquo;s rules and holds any stake. Both are needed.
      </p>
    </div>
  );
}
