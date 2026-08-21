import { PlayerAvatar } from "@/components/PlayerAvatar";
import { positionColour, shortName } from "@/lib/player";

/**
 * The hero's right column: a draft, mid-round.
 *
 * **Illustrative, and it has to say so.** These are not real players and there
 * is no live draft behind them — a marketing page cannot show one, because a
 * public draft in progress is not a thing that reliably exists at the moment
 * somebody visits. What it must not do is *imply* live data on a product whose
 * entire argument is that nothing here is invented, so the caption names it as a
 * sample and the numbers below are internally consistent rather than decorative.
 *
 * **It reproduces the shipped component rather than approximating it**, which is
 * what drop 6's README asks for and the reason it imports from `lib/player`
 * instead of hard-coding colours:
 *
 *   - cells are filled **by position** from `POSITION_COLOURS`, at their real
 *     alpha and ring
 *   - each row carries a **direction arrow**, because the snake reversal is the
 *     one thing people get wrong when planning two picks ahead
 *   - columns hold `min-w-[7.5rem]` — 120px — showing **three of twelve teams at
 *     full width rather than twelve squeezed**, since below 120px `shortName`'s
 *     surnames truncate and initialling the given name stops buying anything
 *
 * The pick numbers are a real snake: round 1 runs forward (1.03, 1.04, 1.05),
 * round 2 comes back (2.10, 2.09, 2.08 — column 3 of 12 is pick 10 in a reversed
 * round), and round 3 runs forward again. A reader who checks it finds it holds,
 * which is the only kind of illustration this product should ship.
 */

interface Cell {
  readonly label: string;
  readonly name: string;
  readonly position: string;
  readonly team: string;
}

/**
 * The player on the clock, and his headshot.
 *
 * **Real, and checked rather than typed from memory.** The provider stores him
 * as `James Cook III` — the suffix is why an exact-name lookup for "James
 * Cook" finds nobody — and this is the `image_url` his row carries, verified
 * against the live database and confirmed to resolve on 2026-08-21.
 *
 * A URL hard-coded here is a marketing asset rather than a data path, and the
 * distinction matters: everywhere in the *app*, an image comes from
 * `players.image_url` and nothing composes one. This page is static and reads
 * no database, so the alternative to a constant is rendering the landing page
 * per request for one picture. `PlayerAvatar` still falls back to initials if
 * it ever 404s.
 */
const ON_THE_CLOCK = {
  name: "James Cook III",
  position: "RB",
  team: "BUF",
  imageUrl: "https://a.espncdn.com/i/headshots/nfl/players/full/4379399.png",
} as const;

/**
 * Three columns of a twelve-team board, rounds one to three.
 *
 * Drop 7 replaced the invented names with real ones, and its own note says the
 * ADP ordering is **a designer's guess rather than data**. Reconciled against
 * the live draft board on 2026-08-21: every player here is on it, and the
 * arrangement is kept as the design drew it rather than re-sorted, because the
 * board is an illustration of a draft in progress and not a ranking anybody
 * should read as one.
 */
const ROUNDS: readonly {
  readonly round: number;
  readonly direction: "FORWARD" | "REVERSE";
  readonly cells: readonly (Cell | null)[];
}[] = [
  {
    round: 1,
    direction: "FORWARD",
    cells: [
      { label: "1.03", name: "Justin Jefferson", position: "WR", team: "MIN" },
      { label: "1.04", name: "Bijan Robinson", position: "RB", team: "ATL" },
      { label: "1.05", name: "Saquon Barkley", position: "RB", team: "PHI" },
    ],
  },
  {
    round: 2,
    direction: "REVERSE",
    cells: [
      { label: "2.10", name: "Brock Bowers", position: "TE", team: "LV" },
      { label: "2.09", name: "Nico Collins", position: "WR", team: "HOU" },
      { label: "2.08", name: "Trey McBride", position: "TE", team: "ARI" },
    ],
  },
  {
    round: 3,
    direction: "FORWARD",
    cells: [
      { label: "3.03", name: "Josh Allen", position: "QB", team: "BUF" },
      // The pick on the clock, and the seat it belongs to.
      null,
      { label: "3.05", name: "", position: "", team: "" },
    ],
  },
];
const COLUMNS = [
  { name: "Pylon Co.", tag: "" },
  { name: "Route 66", tag: "you" },
  { name: "Tuesday Night Reg…", tag: "" },
] as const;

export function LandingDraftBoard() {
  return (
    <aside className="relative hidden lg:block" aria-label="A draft in progress, as an example">
      <div className="flex items-baseline justify-between px-1 pb-3">
        <span className="text-[11px] tracking-[0.14em] text-nocturne-neutral-600 uppercase">
          Live draft · Round 3
        </span>
        <span className="text-[13px] tabular-nums text-nocturne-neutral-400">0:47</span>
      </div>

      {/* The card for the pick on the clock, above the board — the one thing a
          manager looks at when it is their turn. */}
      <div className="flex items-center gap-4 rounded-lg border border-nocturne-accent/40 bg-nocturne-accent/10 p-4">
        {/*
          96px, the size `PlayerAvatar` documents for a card portrait and the
          size drop 6's README asks for — at 52px the component's own empty
          state overflows its host.
        */}
        <PlayerAvatar
          name={ON_THE_CLOCK.name}
          positions={[ON_THE_CLOCK.position]}
          imageUrl={ON_THE_CLOCK.imageUrl}
          size={96}
        />
        <span className="min-w-0">
          <span className="block text-[10px] tracking-[0.14em] text-nocturne-accent-300 uppercase">
            Your pick, 3.04
          </span>
          <span className="mt-1 block truncate text-[19px] font-medium">
            {ON_THE_CLOCK.name}
          </span>
          <span className="mt-1 flex items-center gap-2 text-[11px] text-nocturne-neutral-500">
            <span
              className={`rounded px-1 py-px font-medium ring-1 ${positionColour(ON_THE_CLOCK.position)}`}
            >
              {ON_THE_CLOCK.position} · {ON_THE_CLOCK.team}
            </span>
          </span>
          {/*
            His real season projection, not a number chosen to look plausible.

            250.1 is what `scorePlayer` returns for his stored projection under
            the default PPR rules — computed against the live database on
            2026-08-21, the same arithmetic the draft board runs. The design
            printed 13.6, which is a *weekly* shape; our board shows projected
            **season** points, so a weekly figure here would have quietly
            described a different product from the one behind the link.

            It will drift as projections are re-synced. That is acceptable for an
            illustration and would not be for a live screen — which is the whole
            reason the caption below says this is a sample.
          */}
          <span className="mt-1 block text-[11px] text-nocturne-neutral-600">
            250.1 proj · top of your queue
          </span>
        </span>
      </div>

      {/*
        The crop, and why the fade is a fixed length.

        The board is twelve columns wide and three of them are shown. The mask
        must be a **fixed** distance rather than a percentage: this aside doubles
        in width when the layout stacks, and a percentage fade would eat a whole
        visible column at the wider size.
      */}
      <div
        className="mt-4 overflow-hidden"
        style={{
          maskImage: "linear-gradient(to right, #000 calc(100% - 88px), transparent 100%)",
          WebkitMaskImage:
            "linear-gradient(to right, #000 calc(100% - 88px), transparent 100%)",
        }}
      >
        <table className="w-full border-separate border-spacing-0">
          <thead>
            <tr>
              <th className="w-6" />
              {COLUMNS.map((column) => (
                <th
                  key={column.name}
                  className="min-w-[7.5rem] px-1 pb-2 text-left align-bottom"
                >
                  <span className="block truncate text-[12px] font-medium text-nocturne-neutral-400">
                    {column.name}
                  </span>
                  <span className="block text-[10px] text-nocturne-neutral-600">
                    {column.tag || " "}
                  </span>
                </th>
              ))}
            </tr>
          </thead>

          <tbody>
            {ROUNDS.map((row) => (
              <tr key={row.round}>
                <td className="pr-1 text-center align-middle">
                  <span className="block text-[11px] text-nocturne-neutral-600 tabular-nums">
                    {row.round}
                  </span>
                  <span className="block text-[10px] text-nocturne-neutral-700">
                    {row.direction === "FORWARD" ? "→" : "←"}
                  </span>
                </td>

                {row.cells.map((cell, index) =>
                  cell === null ? (
                    <td key={`clock-${row.round}`} className="p-0.5 align-top">
                      <div className="flex h-14 flex-col justify-center rounded bg-nocturne-accent/20 px-2 ring-1 ring-nocturne-accent">
                        <span className="text-[10px] text-nocturne-accent-200 tabular-nums">
                          3.04
                        </span>
                        <span className="text-xs font-medium text-nocturne-accent-200">
                          On the clock
                        </span>
                      </div>
                    </td>
                  ) : cell.name === "" ? (
                    <td key={`empty-${row.round}-${index}`} className="p-0.5 align-top">
                      <div className="flex h-14 flex-col justify-center rounded bg-nocturne-surface/20 px-2">
                        <span className="text-[10px] text-nocturne-neutral-700 tabular-nums">
                          {cell.label}
                        </span>
                      </div>
                    </td>
                  ) : (
                    <td key={cell.label} className="p-0.5 align-top">
                      <div
                        className={`flex h-14 flex-col justify-center rounded px-2 ring-1 ${positionColour(cell.position)}`}
                      >
                        <span className="flex items-baseline justify-between gap-1">
                          <span className="truncate text-xs font-medium">
                            {shortName(cell.name)}
                          </span>
                          <span className="shrink-0 text-[10px] opacity-70 tabular-nums">
                            {cell.label}
                          </span>
                        </span>
                        <span className="truncate text-[10px] opacity-80">
                          {cell.position} · {cell.team}
                        </span>
                      </div>
                    </td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-3 px-1 text-[12px] leading-[1.5] text-nocturne-neutral-600">
        {/*
          Says it is a sample, and points at the claim that is not. The draw is
          the checkable half and it is the reason this illustration is here.
        */}
        A sample board. Three of twelve teams. In a real league the order is drawn from a Solana
        block nobody could pick in advance.{" "}
        <a href="#how" className="text-nocturne-accent-300 hover:underline">
          How the draw works
        </a>
      </p>
    </aside>
  );
}
