/**
 * Rendering an instant with its zone named.
 *
 * Server components format in Node's locale — UTC on Vercel — while a
 * commissioner picks a draft time in their own zone in a `datetime-local`
 * field. An unlabelled wall-clock reading is silently wrong for everyone
 * outside that zone, and off by a day boundary for an evening draft. Naming the
 * zone makes it correct rather than merely careful.
 *
 * ## Why this is not in the component that uses it
 *
 * It was, and it threw on every render — see {@link withZone}. `apps/web` has
 * no jsdom in either vitest project, so nothing that lives in a `.tsx` file can
 * be exercised by a test: the checklist compiled, typechecked, passed the whole
 * suite, and produced a 500 the first time a commissioner opened their own
 * league. Moved here so the formatting is covered by a node test, which is the
 * same reasoning that put `commissionerSetup` in `lib/setup.ts` and the lobby's
 * view model in `lib/lobby.ts`.
 */

/**
 * A date and time with the time zone named — "August 25, 2026 at 2:00 PM EDT".
 *
 * ## The bug this exists to prevent recurring
 *
 * The first version asked for `dateStyle: "long"`, `timeStyle: "short"` and
 * `timeZoneName: "short"` together. ECMA-402 forbids that combination outright:
 * `dateStyle` and `timeStyle` are shorthands for a whole pattern, so pairing
 * either with an individual component option is a `TypeError: Invalid option`,
 * thrown on every call in every runtime. Not a fallback, not a locale
 * difference — always.
 *
 * So the components are spelled out individually. It is more to read and it is
 * the only form that can carry the zone.
 */
export function withZone(at: Date): string {
  return at.toLocaleString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}
