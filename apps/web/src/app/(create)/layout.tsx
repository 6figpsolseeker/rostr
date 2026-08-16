import type { ReactNode } from "react";

/**
 * Creating a league gets its own frame.
 *
 * Not the signed-in chrome: the design puts this screen on the Nocturne ground
 * with its own header and no utility nav, and it is the one flow where the
 * surrounding application is a distraction — the whole screen is a document you
 * are about to sign, and the second step is a ceremony that should not have a
 * "Create league" button sitting above it.
 *
 * Not the marketing frame either, because this is behind a session.
 *
 * A route group, so the URL does not move: `/leagues/new` is exactly where it
 * was.
 */
export default function CreateLayout({ children }: { children: ReactNode }) {
  return <div className="nocturne min-h-screen">{children}</div>;
}
