import { redirect } from "next/navigation";
import { getWallets } from "@rostr/db";
import { CompleteAccount } from "@/components/CompleteAccount";
import { db } from "@/lib/db";
import { accountComplete } from "@/lib/account";
import { currentUser, safeRedirect } from "@/lib/session";

/**
 * The rest of signing up.
 *
 * An account is an email, a username and a wallet. Sign-in collects the first
 * and this collects the other two — **not** because it is tidier, but because
 * `beginEmailSignIn` answers identically whether or not an address is already
 * registered, and a sign-up form that asked for a username up front would
 * publish which emails have accounts here to anyone who tried one.
 *
 * A finished account is bounced straight through, so this is safe to link to
 * from anywhere and safe to land on twice.
 */
export default async function WelcomePage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const user = await currentUser();

  // `next` is carried through the sign-in redirect, so it survives the round
  // trip from here to the code and back.
  const destination = safeRedirect(next ?? null);

  if (!user) {
    redirect(`/signin?next=${encodeURIComponent(`/welcome?next=${destination}`)}`);
  }

  const wallets = await getWallets(db(), user.id);

  if (accountComplete({ username: user.username, verifiedWallets: wallets.length })) {
    redirect(destination);
  }

  return (
    <div className="max-w-xl space-y-8">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Two things left</h1>
        <p className="text-sm text-nocturne-neutral-400">
          You are signed in as <span className="text-nocturne-text">{user.email}</span>. A
          username is how people invite you; a wallet is how you sign what you agree to.
        </p>
      </div>

      <CompleteAccount
        initialUsername={user.username}
        initialWallets={wallets.map((wallet) => wallet.address)}
        next={destination}
      />
    </div>
  );
}
