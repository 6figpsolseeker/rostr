/**
 * Canonical JSON encoding.
 *
 * A league's rules are hashed and that hash is written on-chain. Members join by
 * signing a transaction that references it. If two machines can encode the same
 * rules into different bytes, they produce different hashes, and every
 * immutability guarantee in this project silently becomes decorative.
 *
 * So encoding is defined here rather than delegated to `JSON.stringify`, whose
 * key order follows insertion order and whose number formatting is not something
 * we want to depend on across engines and versions.
 *
 * Rules:
 *
 *   - Object keys are sorted by UTF-16 code unit (the default `Array#sort`
 *     ordering, which is specified and identical everywhere).
 *   - Numbers must be safe integers. Non-integers throw. See below.
 *   - Arrays keep their order — it is meaningful (scoring tiers, payout ranks).
 *   - `undefined`, functions, symbols, and non-plain objects are rejected rather
 *     than silently dropped the way `JSON.stringify` drops them.
 *   - No whitespace. There is exactly one encoding of any given value.
 *
 * ## Why integers only
 *
 * Passing yards score 0.04 points each. In IEEE 754, `0.04 * 25 === 1.0000000000000002`,
 * and `0.1 + 0.2 !== 0.3`. Serialising such values invites two libraries to
 * disagree in the seventeenth decimal place, which is enough to change a hash.
 *
 * Rather than police that, the type system forbids it: all quantities are stored
 * as integers in their smallest unit — milli-points for scoring, basis points for
 * percentages, explicit numerator/denominator pairs for thresholds. Floats never
 * enter the rule set, so they can never drift.
 */

import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";

export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

export class CanonicalEncodingError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(`${message} (at ${path || "<root>"})`);
    this.name = "CanonicalEncodingError";
  }
}

function encode(value: unknown, path: string): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";

    case "number":
      if (!Number.isSafeInteger(value)) {
        throw new CanonicalEncodingError(
          `Only safe integers may be encoded; got ${String(value)}. ` +
            `Store fractional quantities in their smallest integer unit ` +
            `(milli-points, basis points) instead.`,
          path,
        );
      }
      // Safe integers stringify identically across every engine, and -0
      // normalises to "0" so it cannot produce a second encoding of zero.
      return String(value === 0 ? 0 : value);

    case "string":
      return JSON.stringify(value);

    case "undefined":
      throw new CanonicalEncodingError(
        "undefined cannot be encoded; omit the key or use null",
        path,
      );

    case "bigint":
      throw new CanonicalEncodingError("bigint cannot be encoded; use a safe integer", path);

    case "function":
    case "symbol":
      throw new CanonicalEncodingError(`${typeof value} cannot be encoded`, path);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item, i) => encode(item, `${path}[${i}]`)).join(",")}]`;
  }

  const proto = Object.getPrototypeOf(value) as unknown;
  if (proto !== Object.prototype && proto !== null) {
    throw new CanonicalEncodingError(
      `Only plain objects may be encoded; got ${(value as object).constructor?.name ?? "unknown"}`,
      path,
    );
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();

  const parts = keys.map((key) => {
    const child = record[key];
    if (child === undefined) {
      throw new CanonicalEncodingError(
        "undefined cannot be encoded; omit the key or use null",
        path ? `${path}.${key}` : key,
      );
    }
    return `${JSON.stringify(key)}:${encode(child, path ? `${path}.${key}` : key)}`;
  });

  return `{${parts.join(",")}}`;
}

/**
 * Encode a value to its single canonical string form.
 *
 * @throws {CanonicalEncodingError} if the value contains anything that cannot be
 * encoded deterministically.
 */
export function canonicalize(value: CanonicalValue): string {
  return encode(value, "");
}

/** SHA-256 of the canonical encoding, lowercase hex. */
export function canonicalHash(value: CanonicalValue): string {
  return bytesToHex(sha256(new TextEncoder().encode(canonicalize(value))));
}
