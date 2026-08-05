/**
 * The sport registry.
 *
 * Nothing below knows what football is. A sport is a set of stat keys, a set of
 * positions, and the lineup slots those positions can fill. Adding basketball
 * means adding a `SportDef`, not editing anything here.
 *
 * The test of whether this holds: no identifier in this file, or in any consumer
 * of it, may contain a football word.
 */

/**
 * How a scoring rule turns a stat value into points.
 *
 * `LINEAR`  — points = value x multiplier. Most stats.
 * `TIERED`  — points = lookup(value in range). Used where the relationship is a
 *             step function rather than a rate; in football, only defensive
 *             points allowed.
 */
export type StatKind = "LINEAR" | "TIERED";

export interface StatKeyDef {
  readonly key: string;
  readonly displayName: string;
  readonly kind: StatKind;
}

export interface PositionDef {
  readonly key: string;
  readonly displayName: string;
  readonly sortOrder: number;
}

export interface SlotTypeDef {
  readonly key: string;
  readonly displayName: string;
  /**
   * Positions permitted in this slot. A multi-position slot (football's FLEX,
   * basketball's G) is expressed by listing several — the engine never learns
   * that certain positions are interchangeable, it just reads the list.
   */
  readonly eligiblePositions: readonly string[];
}

export interface SportDef {
  readonly key: string;
  readonly displayName: string;
  /** Weeks in the sport's season, including any the league chooses not to use. */
  readonly seasonWeeks: number;
  readonly statKeys: readonly StatKeyDef[];
  readonly positions: readonly PositionDef[];
  readonly slotTypes: readonly SlotTypeDef[];
}

export function statKeysByKey(sport: SportDef): ReadonlyMap<string, StatKeyDef> {
  return new Map(sport.statKeys.map((s) => [s.key, s]));
}

export function slotTypesByKey(sport: SportDef): ReadonlyMap<string, SlotTypeDef> {
  return new Map(sport.slotTypes.map((s) => [s.key, s]));
}

export function positionsByKey(sport: SportDef): ReadonlyMap<string, PositionDef> {
  return new Map(sport.positions.map((p) => [p.key, p]));
}

/**
 * Validate a sport definition's internal consistency.
 *
 * Returns the problems found rather than throwing, so a caller can report all of
 * them at once. An empty array means the definition is coherent.
 */
export function validateSport(sport: SportDef): string[] {
  const problems: string[] = [];

  const dupe = (label: string, keys: readonly string[]): void => {
    const seen = new Set<string>();
    for (const k of keys) {
      if (seen.has(k)) problems.push(`duplicate ${label} key: ${k}`);
      seen.add(k);
    }
  };

  dupe(
    "stat",
    sport.statKeys.map((s) => s.key),
  );
  dupe(
    "position",
    sport.positions.map((p) => p.key),
  );
  dupe(
    "slot type",
    sport.slotTypes.map((s) => s.key),
  );

  const positions = new Set(sport.positions.map((p) => p.key));
  for (const slot of sport.slotTypes) {
    if (slot.eligiblePositions.length === 0) {
      problems.push(`slot type ${slot.key} permits no positions`);
    }
    for (const p of slot.eligiblePositions) {
      if (!positions.has(p)) {
        problems.push(`slot type ${slot.key} references unknown position ${p}`);
      }
    }
  }

  if (sport.seasonWeeks <= 0) {
    problems.push(`seasonWeeks must be positive, got ${sport.seasonWeeks}`);
  }

  return problems;
}
