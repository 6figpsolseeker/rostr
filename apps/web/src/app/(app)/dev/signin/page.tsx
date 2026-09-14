import { notFound } from "next/navigation";
import { PrivyTestPanel } from "@/components/PrivyTestPanel";

/**
 * A bare page for trying Privy sign-in before the real screens exist.
 *
 * **Temporary, and never served in production.** The owner is designing the
 * sign-in screens; this exists so the whole exchange — Privy login, wallet
 * creation, `POST /api/auth/privy`, the rostr session — can be seen working
 * end to end first. Delete it when those screens land.
 */
export default function DevSignInPage() {
  if (process.env.NODE_ENV === "production") notFound();

  return (
    <div className="max-w-xl space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Privy sign-in test</h1>
      <p className="text-sm text-nocturne-neutral-400">Temporary. Local development only.</p>
      <PrivyTestPanel />
    </div>
  );
}
