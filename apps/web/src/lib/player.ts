/**
 * What a screen shows about a player, decided where a test can reach it.
 *
 * `apps/web` cannot render a component in a test — both vitest projects are
 * node-environment with no jsdom — so a rule written inside a `.tsx` file is
 * verified only by being run in production. Every one of these is a rule with a
 * wrong answer worth catching: an age that is a year out, initials that read
 * "PA" for "Puka Nacua", a headshot request that arrives without its size.
 *
 * Nothing here decides anything. It is all presentation, and the code that
 * decides a lineup, a pick or a payout must never come to read it.
 */

/** The positions the app colours and groups by, in roster order. */
export const POSITION_ORDER = ["QB", "RB", "WR", "TE", "K", "DEF"] as const;

export type PositionKey = (typeof POSITION_ORDER)[number];

/**
 * A player's group.
 *
 * Multi-position players are filed under the first position the roster cares
 * about, so a receiver who also returns kicks appears once rather than twice.
 * The same rule the draft board has always used, lifted here so the board, the
 * roster and the card cannot disagree about which colour a man is.
 */
export function positionGroup(positions: readonly string[]): string {
  for (const position of POSITION_ORDER) {
    if (positions.includes(position)) return position;
  }
  return positions[0] ?? "—";
}

/**
 * Position colours, as a foreground/background pair.
 *
 * Written out per position rather than generated from a hue, because these are
 * read at a glance on a moving board and the pairs were checked for contrast
 * individually. Tailwind cannot see a class name built at runtime, so these are
 * literal utility strings and not interpolated fragments.
 */
const POSITION_COLOURS: Readonly<Record<string, string>> = {
  QB: "bg-rose-500/15 text-rose-300 ring-rose-500/30",
  RB: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
  WR: "bg-sky-500/15 text-sky-300 ring-sky-500/30",
  TE: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
  K: "bg-violet-500/15 text-violet-300 ring-violet-500/30",
  DEF: "bg-teal-500/15 text-teal-300 ring-teal-500/30",
};

const UNKNOWN_POSITION =
  "bg-nocturne-neutral-800 text-nocturne-neutral-300 ring-nocturne-neutral-700";

/** Tailwind classes for a position chip. An unmodelled position still renders. */
export function positionColour(position: string): string {
  return POSITION_COLOURS[position] ?? UNKNOWN_POSITION;
}

/**
 * Initials for the fallback avatar.
 *
 * Two letters, from the first and last word — so "Amon-Ra St. Brown" reads
 * "AB" rather than "AS", and a one-word name ("Cowboys") gives a single letter
 * rather than repeating it. Punctuation-only tokens are skipped, which is what
 * stops "St." contributing a full stop.
 */
export function initialsOf(name: string): string {
  const words = name
    .split(/[\s]+/)
    .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter((word) => word.length > 0);

  if (words.length === 0) return "?";

  const first = words[0]![0]!;
  const last = words.length > 1 ? words[words.length - 1]![0]! : "";
  return (first + last).toUpperCase();
}

/**
 * Age in whole years on a given day.
 *
 * Takes `today` rather than calling `Date.now()`, so a birthday is testable and
 * a server render agrees with itself. Compared on calendar parts rather than by
 * dividing a millisecond difference: a leap year makes the arithmetic version
 * one day wrong once every four years, and it is wrong on somebody's birthday,
 * which is the only day anybody would notice.
 */
export function ageOn(birthDate: string | null, today: Date): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthDate ?? "");
  if (!match) return null;

  const [, year, month, day] = match;
  const born = { year: Number(year), month: Number(month), day: Number(day) };

  // UTC parts, matching the ISO string's own frame. Local parts would shift the
  // date for anyone west of Greenwich and hand back an age a day early.
  let age = today.getUTCFullYear() - born.year;
  const monthNow = today.getUTCMonth() + 1;
  const dayNow = today.getUTCDate();

  if (monthNow < born.month || (monthNow === born.month && dayNow < born.day)) age -= 1;
  return age >= 0 && age < 150 ? age : null;
}

/** `74` to `6'2"`. Null passes through, so a caller can render one dash. */
export function heightText(inches: number | null): string | null {
  if (inches === null || inches <= 0) return null;
  return `${Math.floor(inches / 12)}'${inches % 12}"`;
}

/**
 * The short badge an injury designation gets on a dense row.
 *
 * Abbreviated to three letters at most, because it sits inside a table cell
 * beside the name. **Unknown wording is truncated, never dropped** — a provider
 * inventing a fourth designation must still reach the screen, and a badge
 * reading "SUS" that somebody has to look up beats a player silently appearing
 * healthy.
 */
export function injuryBadge(designation: string | null): string | null {
  if (designation === null) return null;

  const known: Readonly<Record<string, string>> = {
    questionable: "Q",
    doubtful: "D",
    out: "OUT",
    "injured reserve": "IR",
    ir: "IR",
    "physically unable to perform": "PUP",
    pup: "PUP",
    suspension: "SUS",
    suspended: "SUS",
  };

  const key = designation.trim().toLowerCase();
  if (key === "") return null;
  return known[key] ?? designation.trim().slice(0, 3).toUpperCase();
}

/**
 * How loudly a designation should read.
 *
 * "Questionable" is information; "Out" is a hole in your lineup. They are given
 * different colours rather than one warning colour, because a board full of
 * amber trains people to ignore amber.
 */
export function injuryTone(designation: string | null): string {
  const badge = injuryBadge(designation);
  if (badge === null) return "";
  return badge === "Q" ? "text-amber-400" : "text-red-400";
}

/**
 * Ask an image host for the size we are going to draw.
 *
 * Headshots are published at full resolution — 223 KB for one of them — and a
 * draft board puts 150 on a page. Where the URL is one of the resizing
 * "combiner" forms, the width and height are appended; anything else is
 * returned untouched rather than guessed at.
 *
 * **This is the one place in the app that knows anything about an image
 * host, and it is deliberately advisory**: get it wrong and the image is merely
 * large. The URL itself always comes from the provider — see migration `0032`
 * for why it is stored rather than composed.
 */
export function sizedImage(url: string | null, pixels: number): string | null {
  if (url === null) return null;
  if (!url.includes("/combiner/i?")) return url;
  if (/[?&]w=/.test(url)) return url;

  const scale = Math.round(pixels * 2); // Retina, and these are small.
  return `${url}&w=${scale}&h=${scale}`;
}

/** Milli-points as a one-decimal string. `null` renders as an em dash. */
export function points(milli: number | null | undefined): string {
  return milli === null || milli === undefined ? "—" : (milli / 1000).toFixed(1);
}

/**
 * `"Christian McCaffrey"` to `"C. McCaffrey"`.
 *
 * A board cell is about eleven characters wide and a surname is the part that
 * identifies somebody, so the given name is initialled rather than the whole
 * string being truncated — "Christian McC…" and "Christian McD…" are the same
 * cell to a reader glancing at it during a ninety-second clock.
 *
 * Single-word names — every team defense — pass through whole, because
 * "C. Cowboys" would be nonsense.
 */
export function shortName(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return name.trim();

  const first = words[0]!;
  const rest = words.slice(1).join(" ");
  const initial = [...first][0] ?? "";
  return `${initial}. ${rest}`;
}
