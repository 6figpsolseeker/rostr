/**
 * Seeding the sport registry.
 *
 * A `SportDef` in `@rostr/core` is the source of truth; these functions project
 * it into rows. Idempotent, so it can run on every boot without accumulating
 * duplicates or orphaning references.
 */

import type { SportDef } from "@rostr/core";
import type { SqlClient } from "./client.js";

export interface SportIds {
  readonly sportId: string;
  readonly statKeyIds: ReadonlyMap<string, string>;
  readonly positionIds: ReadonlyMap<string, string>;
  readonly slotTypeIds: ReadonlyMap<string, string>;
}

export class SportNotSeededError extends Error {
  constructor(sportKey: string) {
    super(`Sport "${sportKey}" is not in the database. Run seedSport() first.`);
    this.name = "SportNotSeededError";
  }
}

interface KeyedRow {
  id: string;
  key: string;
}

function toMap(rows: readonly KeyedRow[]): Map<string, string> {
  return new Map(rows.map((r) => [r.key, r.id]));
}

/**
 * Insert or update a sport and its registry.
 *
 * Rows are never deleted — a stat key or position that disappeared from the
 * definition may still be referenced by historic `stat_lines` or a league's
 * frozen scoring rules, and those must stay readable.
 */
export async function seedSport(db: SqlClient, sport: SportDef): Promise<SportIds> {
  const [sportRow] = await db.query<{ id: string }>(
    `INSERT INTO sports (key, display_name, season_weeks, active)
     VALUES ($1, $2, $3, true)
     ON CONFLICT (key) DO UPDATE
       SET display_name = EXCLUDED.display_name,
           season_weeks = EXCLUDED.season_weeks,
           active = true
     RETURNING id`,
    [sport.key, sport.displayName, sport.seasonWeeks],
  );
  const sportId = sportRow!.id;

  for (const stat of sport.statKeys) {
    await db.query(
      `INSERT INTO stat_keys (sport_id, key, display_name, kind)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (sport_id, key) DO UPDATE
         SET display_name = EXCLUDED.display_name, kind = EXCLUDED.kind`,
      [sportId, stat.key, stat.displayName, stat.kind],
    );
  }

  for (const position of sport.positions) {
    await db.query(
      `INSERT INTO positions (sport_id, key, display_name, sort_order)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (sport_id, key) DO UPDATE
         SET display_name = EXCLUDED.display_name, sort_order = EXCLUDED.sort_order`,
      [sportId, position.key, position.displayName, position.sortOrder],
    );
  }

  for (const slot of sport.slotTypes) {
    await db.query(
      `INSERT INTO slot_types (sport_id, key, display_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (sport_id, key) DO UPDATE SET display_name = EXCLUDED.display_name`,
      [sportId, slot.key, slot.displayName],
    );
  }

  const ids = await loadSportIds(db, sport.key);

  for (const slot of sport.slotTypes) {
    const slotTypeId = ids.slotTypeIds.get(slot.key)!;
    for (const positionKey of slot.eligiblePositions) {
      const positionId = ids.positionIds.get(positionKey);
      if (!positionId) {
        throw new Error(
          `Slot type "${slot.key}" references position "${positionKey}", which is not defined for ${sport.key}`,
        );
      }
      await db.query(
        `INSERT INTO slot_type_positions (slot_type_id, position_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [slotTypeId, positionId],
      );
    }
  }

  return ids;
}

/** Look up the registry ids for an already-seeded sport. */
export async function loadSportIds(db: SqlClient, sportKey: string): Promise<SportIds> {
  const [sportRow] = await db.query<{ id: string }>("SELECT id FROM sports WHERE key = $1", [
    sportKey,
  ]);
  if (!sportRow) throw new SportNotSeededError(sportKey);

  const [statKeys, positions, slotTypes] = await Promise.all([
    db.query<KeyedRow>("SELECT id, key FROM stat_keys WHERE sport_id = $1", [sportRow.id]),
    db.query<KeyedRow>("SELECT id, key FROM positions WHERE sport_id = $1", [sportRow.id]),
    db.query<KeyedRow>("SELECT id, key FROM slot_types WHERE sport_id = $1", [sportRow.id]),
  ]);

  return {
    sportId: sportRow.id,
    statKeyIds: toMap(statKeys),
    positionIds: toMap(positions),
    slotTypeIds: toMap(slotTypes),
  };
}
