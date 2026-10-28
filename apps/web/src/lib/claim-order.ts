/**
 * Ordering a manager's own pending waiver claims. Issue #125.
 *
 * In `lib` for the reason `waiver-run.ts` and `lobby.ts` record: `apps/web` has
 * no jsdom in either vitest project, so logic written inside a `.tsx` is checked
 * only by running it in production. The drag-and-drop control in
 * `PlayerMarket` calls these and decides nothing itself.
 */

/**
 * A ceiling on the request, not a rule about claims. Nothing caps how many
 * claims a team may file, so this sits far above anything a manager reaches; it
 * only stops a crafted body sending an enormous list.
 */
export const MAX_REORDER = 500;

/**
 * Move `activeId` to where `overId` sits, as a drag does.
 *
 * Returns the input unchanged for an unknown id on either side — the claim a
 * run processed while the manager was dragging — and for a drop onto itself.
 * Never mutates.
 */
export function moveClaim(
  ids: readonly string[],
  activeId: string,
  overId: string,
): readonly string[] {
  const from = ids.indexOf(activeId);
  const to = ids.indexOf(overId);
  if (from === -1 || to === -1 || from === to) return ids;

  const next = [...ids];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}

/**
 * The route's reading of a reorder body: a bounded list of strings, or `null`
 * for anything else, which the route answers 400.
 *
 * Shape only. Whether the ids are exactly this team's pending claims is the
 * database's question, asked under its lock — see `reorderClaims`.
 */
export function parseClaimIds(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length > MAX_REORDER) return null;
  return value.every((id) => typeof id === "string") ? (value as string[]) : null;
}
