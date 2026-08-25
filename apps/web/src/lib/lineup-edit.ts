/**
 * What a manager's single lineup change means, applied to a slot list.
 *
 * `LineupEditor` posts the **whole** slot list on every dropdown change, so the
 * request body carries a manager's one decision surrounded by eight slots they
 * did not touch. That is fine on the way out — the server compares each slot
 * against its own fresh read — but it makes the change itself unrecoverable
 * afterwards: nothing in the payload distinguishes "I chose this" from "this is
 * what my page happened to show".
 *
 * It matters on exactly one path. A `LINEUP_MOVED` refusal is retried once
 * against a re-read lineup, and the retry has to re-apply the manager's decision
 * to what the server now holds. The first version of that merge compared the
 * stale list against the fresh one and kept the stale value wherever they
 * differed — which is every slot another writer had moved, not the one the
 * manager touched. Its comment claimed the opposite ("keeping this manager's own
 * change and taking everything else from the refresh"), and what it did was
 * revert the other writer across the whole lineup.
 *
 * So the edit is carried as an edit, and the same function applies it both
 * times. One definition, rather than an apply and a re-apply that can disagree.
 *
 * This lives in `lib/` rather than in the component because `apps/web` has no
 * jsdom in either vitest project: a rule written in `.tsx` is verified only by
 * being run in production, and this one is reached only by a race.
 */

export interface LineupSlot {
  readonly slotType: string;
  readonly slotIndex: number;
  readonly playerId: string | null;
}

export interface LineupEdit {
  readonly slotType: string;
  readonly slotIndex: number;
  readonly playerId: string | null;
}

const sameSlot = (a: { slotType: string; slotIndex: number }, b: LineupEdit): boolean =>
  a.slotType === b.slotType && a.slotIndex === b.slotIndex;

/**
 * Apply one change to a slot list, vacating the player's previous slot.
 *
 * Moving a player into a slot takes him out of wherever he was — otherwise the
 * submission holds him twice and `validateLineup` refuses the whole lineup for a
 * second slot the manager did not think they were editing.
 *
 * Clearing a slot (`playerId: null`) vacates nothing else: there is no player to
 * find elsewhere, and the `playerId === null` guard is what stops every empty
 * slot in the list being treated as "the same player" and blanked together.
 */
export function applyLineupEdit<T extends LineupSlot>(
  slots: readonly T[],
  edit: LineupEdit,
): T[] {
  return slots.map((slot) => {
    if (sameSlot(slot, edit)) return { ...slot, playerId: edit.playerId };
    if (edit.playerId !== null && slot.playerId === edit.playerId) {
      return { ...slot, playerId: null };
    }
    return slot;
  });
}
