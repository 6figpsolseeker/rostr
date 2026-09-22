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
 * Average draft position, from milli-units. `3200` renders `"3.2"`.
 *
 * Same scale and same shape as {@link points} — `syncRankings` stores
 * `Math.round(adp * 1000)` for the same reason scoring uses milli-points, and
 * ADP is genuinely fractional, so the decimal is the number rather than
 * decoration.
 *
 * **The em dash is the whole point of this function.** An unranked player still
 * carries a dense board `rank`, and the room used to print that under a column
 * headed ADP — a confident invented number for 1,022 of the 1,589 players on
 * the 2026 board. "Nobody has published one" and "he goes around pick 1,187"
 * are different claims and only one of them is true.
 */
export function adp(milli: number | null | undefined): string {
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

/**
 * What to show where a player's NFL club goes, and whether a bye means anything.
 *
 * ## Why these are functions rather than two `&&`s in a component
 *
 * `apps/web` cannot render a component in a test — both vitest projects are
 * node-environment with no jsdom — so a rule written in `.tsx` is verified only
 * by being run in production. Every mistake #308 is about was of that shape: a
 * `{player?.teamRef && …}` with no `else`, and a bye chip that consulted only
 * whether a number was present.
 *
 * ## The fact they read, and the one they must not
 *
 * `onNflRoster` comes from `players.active`, which is what the draft board and
 * the player market already key on. **Never `teamRef`.** The adapter maps the
 * two from different provider fields, so they disagree in both directions — a
 * listed player with a blank club reads `teamRef` null, and a released player
 * can keep a club abbreviation. Keying the label on `teamRef` would put "FA"
 * on a rostered player and say nothing about some released ones.
 *
 * The card opens from the board, the market, a market roster row and the lineup
 * screen, so it is the screen most likely to contradict a label the manager read
 * one click earlier. Its own docstring says why that matters: "a player who
 * reads differently depending on which screen you came from is a player somebody
 * will mis-draft."
 */
export interface ClubFacts {
  readonly teamRef: string | null;
  readonly onNflRoster: boolean;
}

/**
 * The club chip: his NFL team, `"FA"` when he has none, `null` when we cannot
 * say.
 *
 * ## "FA" means one thing here, and only one
 *
 * **No NFL club employs him** — Tyreek Hill, Joe Mixon. Owner's rule,
 * 2026-09-20. It is the convention every other fantasy app uses in this column,
 * and it is a fact about the real world rather than about any league.
 *
 * It does **not** mean "available to add in this league". A player nobody has
 * rostered belongs in the free-agency pool, and that is what that page is for —
 * but Rashod Bateman sitting in it is on the Baltimore Ravens, so his chip
 * reads `BAL`. The two facts are independent and all four combinations happen:
 * Hill can have no NFL club *and* be rostered by somebody; Bateman can be
 * NFL-rostered *and* unrostered here.
 *
 * Conflating them is not hypothetical — this column previously showed `"FA"`
 * for the **opposite** case, a player who *is* NFL-rostered but whose club value
 * is missing, which is the one row where the letters were certainly wrong.
 *
 * ## The three answers
 *
 * - `"FA"` — `onNflRoster` is false. He has no NFL team.
 * - the club — we hold it.
 * - `null` — he is on an NFL roster and the club value is blank. **Not "FA"**:
 *   that would claim he has no team when what we have is a gap in our own feed.
 *   The caller renders nothing. Silence is the honest answer to "we know he is
 *   listed and not where".
 *
 * Keyed on `onNflRoster` (`players.active`) rather than `teamRef`, because the
 * adapter maps the two from different provider fields and they disagree in both
 * directions.
 */
export function clubLabel({ teamRef, onNflRoster }: ClubFacts): string | null {
  if (!onNflRoster) return "FA";
  return teamRef;
}

/**
 * The bye week to show, or `null` when a bye is not a fact about this player.
 *
 * A released player keeps the `player_seasons` row his old club gave him —
 * `syncByeWeeks` matches on `team_ref`, so it never revisits him to clear it.
 * The card therefore printed `bye 9` for him: specific, plausible and false,
 * every time it was opened, beside a blank club.
 */
export function byeChip({
  byeWeek,
  onNflRoster,
}: {
  readonly byeWeek: number | null;
  readonly onNflRoster: boolean;
}): number | null {
  if (!onNflRoster) return null;
  return byeWeek;
}

/** What a lineup row should say about a player's week, beside his points. */
export interface WeekNote {
  /** The chip. Short — two or three characters, except "no club". */
  readonly short: string;
  /** The tooltip. States the observable and gives no advice. */
  readonly detail: string;
}

/**
 * Why this player may not score this week, or `null` when nothing is unusual.
 *
 * ## `onNflRoster` wins over everything, including a fixture
 *
 * That ordering is the whole function, and it is not obvious, so: a released
 * player's `availability` is usually **`SCHEDULED`**. `loadRosterForWeek` gates
 * its fallback on whether the club appears anywhere in the *season's* schedule,
 * and hands anyone who fails that the week's first kickoff rather than null — on
 * purpose, so his slot still locks. `gameAvailability` then sees a real kickoff.
 *
 * "Usually" because two states escape it: a week with no stored games has no
 * first kickoff to fall back on, and a released player who kept his club
 * abbreviation follows that club's fixtures, bye included. The flag is checked
 * first precisely so none of that matters here.
 *
 * So a screen reading `availability` alone shows him as playing a game that
 * does not exist, with a lock countdown, and marks him "played" from the week's
 * first kickoff. Checking the club flag only when the schedule has nothing to
 * say would therefore never fire for the player this exists for.
 *
 * ## And it is claimed from the flag alone
 *
 * Never from a missing bye. `syncByeWeeks` is the only writer of
 * `player_seasons`, so before it runs for a season every player looks
 * bye-less — reading that as "no club" would relabel the entire league. That is
 * the failure #182 fixed, inverted.
 */
export function weekNote({
  availability,
  onNflRoster,
}: {
  readonly availability: "SCHEDULED" | "TIME_TBD" | "BYE" | "UNSCHEDULED";
  readonly onNflRoster: boolean;
}): WeekNote | null {
  if (!onNflRoster) {
    return {
      short: "no club",
      detail:
        "He is not listed with an NFL club, so no fixture is stored for him and " +
        "he cannot score this week.",
    };
  }

  if (availability === "BYE") {
    return { short: "bye", detail: "His club is on its bye this week." };
  }

  if (availability === "TIME_TBD") {
    return {
      short: "TBD",
      detail:
        "He plays this week. The NFL has not fixed the kickoff time, so this " +
        "slot locks at the earliest hour the game could start.",
    };
  }

  if (availability === "UNSCHEDULED") {
    return {
      short: "TBD",
      detail:
        "No fixture stored for his team this week, and it is not their bye. " +
        "Check back once the schedule syncs.",
    };
  }

  return null;
}
