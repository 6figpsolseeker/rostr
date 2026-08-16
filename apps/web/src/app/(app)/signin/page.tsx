import { SignInForm } from "@/components/SignInForm";
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
        <p className="text-sm text-white/60">
          You are signed in as <span className="text-white">{user.email}</span>.
        </p>
        <a href="/" className="inline-block text-sm text-[--color-turf] hover:underline">
          Go to leagues
        </a>
      </div>
    );
  }

  return (
    <div className="max-w-md space-y-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
        <p className="text-sm text-white/60">
          Enter your email and we will send a link. No password to forget or leak.
        </p>
      </div>

      {error && MESSAGES[error] && (
        <p className="rounded border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          {MESSAGES[error]}
        </p>
      )}

      <SignInForm next={next ?? "/"} />

      <p className="text-xs text-white/40">
        You will link a wallet after signing in. Email is how we reach you; the wallet is what
        signs your consent to a league&rsquo;s rules and holds any stake. Both are needed.
      </p>
    </div>
  );
}
