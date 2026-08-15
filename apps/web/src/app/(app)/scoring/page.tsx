import {
  NFL_PPR_SCORING,
  NFL_PPR_ROSTER,
  formatPoints,
  indexScoringRules,
  scorePlayer,
} from "@rostr/core";
import type { ScoringRule, StatLine } from "@rostr/core";

/**
 * How scoring works, in plain language.
 *
 * **Generated from `NFL_PPR_SCORING`, never hand-written.** A scoring explainer
 * typed out by hand drifts from the engine the first time a value changes, and
 * then quietly lies to users about how they are being scored. Every number on
 * this page is read from the same constant the scoring engine uses, and the
 * worked examples are computed by calling `scorePlayer` — so if they ever
 * disagree with reality, they disagree visibly.
 */

export const metadata = {
  title: "How scoring works — rostr",
  description: "Every way to earn and lose fantasy points, and how the maths works.",
};

const RULES = indexScoringRules(NFL_PPR_SCORING);

const LABELS: Record<string, string> = {
  pass_yd: "Passing yards",
  pass_td: "Passing touchdown",
  pass_int: "Interception thrown",
  rush_yd: "Rushing yards",
  rush_td: "Rushing touchdown",
  rec: "Reception (catch)",
  rec_yd: "Receiving yards",
  rec_td: "Receiving touchdown",
  fum_lost: "Fumble lost",
  two_pt: "Two-point conversion",
  ret_td: "Kick or punt return touchdown",
  fg_0_39: "Field goal, under 40 yards",
  fg_40_49: "Field goal, 40–49 yards",
  fg_50_plus: "Field goal, 50+ yards",
  xp_made: "Extra point",
  def_sack: "Sack",
  def_int: "Interception",
  def_fum_rec: "Fumble recovery",
  def_safety: "Safety",
  def_td: "Defensive touchdown",
  def_blk_kick: "Blocked kick",
  def_pts_allowed: "Points allowed",
};

const NOTES: Record<string, string> = {
  pass_yd: "1 point per 25 yards",
  rush_yd: "1 point per 10 yards",
  rec_yd: "1 point per 10 yards",
  rec: "Full PPR — every catch counts, even a 1-yard dump-off",
  ret_td: "Scored by the returner, separate from the defense",
  def_pts_allowed: "Fewer points allowed, more points earned",
};

const GROUPS: { title: string; keys: string[]; blurb: string }[] = [
  {
    title: "Quarterbacks",
    keys: ["pass_yd", "pass_td", "pass_int"],
    blurb:
      "Passing touchdowns are worth 4, not 6 — a quarterback who throws for a score gets less than the receiver who catches it. That is standard everywhere and keeps quarterbacks from dominating.",
  },
  {
    title: "Running backs and receivers",
    keys: ["rush_yd", "rush_td", "rec", "rec_yd", "rec_td"],
    blurb:
      "Rushing and receiving yards are worth more per yard than passing yards, and touchdowns are worth 6.",
  },
  {
    title: "Everyone on offense",
    keys: ["fum_lost", "two_pt", "ret_td"],
    blurb: "Applies to any player, whatever their position.",
  },
  {
    title: "Kickers",
    keys: ["fg_0_39", "fg_40_49", "fg_50_plus", "xp_made"],
    blurb:
      "Longer field goals are worth more. Missed kicks cost nothing — a kicker should not be punished for his coach attempting a 58-yarder.",
  },
  {
    title: "Defense / Special Teams",
    keys: ["def_sack", "def_int", "def_fum_rec", "def_safety", "def_td", "def_blk_kick"],
    blurb:
      "You start one defense as a unit, not individual defenders. It scores for making plays — and separately for how few points it allows.",
  },
];

function linear(statKey: string): number | null {
  const rule = RULES.get(statKey);
  return rule?.kind === "LINEAR" ? rule.milliPointsPerUnit : null;
}

function tiered(statKey: string): Extract<ScoringRule, { kind: "TIERED" }> | null {
  const rule = RULES.get(statKey);
  return rule?.kind === "TIERED" ? rule : null;
}

/** Milli-points to a readable string, trimming a pointless ".00". */
function display(milli: number): string {
  const text = formatPoints(milli);
  const trimmed = text.replace(/\.00$/, "").replace(/0$/, "");
  return milli > 0 ? `+${trimmed}` : trimmed;
}

export default function ScoringPage() {
  const pointsAllowed = tiered("def_pts_allowed");

  return (
    <div className="space-y-12">
      <header className="space-y-4">
        <h1 className="text-3xl font-semibold tracking-tight">How scoring works</h1>
        <p className="max-w-2xl text-white/70">
          Your team scores points every week based on what your players actually did in their
          real NFL games. Add up your starters, and whoever scores more than their opponent that
          week wins.
        </p>
        <p className="max-w-2xl text-sm text-white/50">
          This is the default full-PPR table. Each league freezes its own copy when it is
          created, so always check that league&rsquo;s rules — they cannot be changed
          afterwards, but they can differ from these.
        </p>
      </header>

      <section className="rounded border border-white/10 p-6">
        <h2 className="mb-3 text-lg font-medium">The short version</h2>
        <ul className="space-y-2 text-sm text-white/70">
          <li>
            <strong className="text-white">Yards give you points slowly</strong> — 10 rushing or
            receiving yards is 1 point, 25 passing yards is 1 point.
          </li>
          <li>
            <strong className="text-white">Touchdowns are the big swing</strong> — 6 points, or
            4 for throwing one.
          </li>
          <li>
            <strong className="text-white">Every catch is worth a point.</strong> That is what
            &ldquo;PPR&rdquo; means: point per reception.
          </li>
          <li>
            <strong className="text-white">Mistakes cost you</strong> — an interception or a
            lost fumble is −2.
          </li>
          <li>
            <strong className="text-white">Only your starters count.</strong> Bench players
            score nothing.
          </li>
        </ul>
      </section>

      {GROUPS.map((group) => (
        <section key={group.title}>
          <h2 className="mb-2 text-lg font-medium">{group.title}</h2>
          <p className="mb-4 max-w-2xl text-sm text-white/60">{group.blurb}</p>

          <div className="overflow-hidden rounded border border-white/10">
            {group.keys.map((statKey) => {
              const milli = linear(statKey);
              if (milli === null) return null;

              return (
                <div
                  key={statKey}
                  className="flex items-baseline justify-between border-b border-white/5 px-4 py-2.5 text-sm last:border-0"
                >
                  <span>
                    {LABELS[statKey] ?? statKey}
                    {NOTES[statKey] && (
                      <span className="ml-2 text-xs text-white/40">{NOTES[statKey]}</span>
                    )}
                  </span>
                  <span className={`font-mono font-medium ${milli < 0 ? "text-red-400" : ""}`}>
                    {display(milli)}
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      ))}

      {pointsAllowed && (
        <section>
          <h2 className="mb-2 text-lg font-medium">Defense: points allowed</h2>
          <p className="mb-4 max-w-2xl text-sm text-white/60">
            On top of the plays above, your defense is scored on how many points the opposing
            offense put up against it. A shutout is worth a lot; getting blown out costs you.
          </p>

          <div className="overflow-hidden rounded border border-white/10">
            {pointsAllowed.tiers.map((tier) => (
              <div
                key={`${tier.min}-${tier.max ?? "up"}`}
                className="flex items-baseline justify-between border-b border-white/5 px-4 py-2.5 text-sm last:border-0"
              >
                <span>
                  {tier.max === null
                    ? `${tier.min} or more points allowed`
                    : tier.min === tier.max
                      ? tier.min === 0
                        ? "Shutout — 0 points allowed"
                        : `${tier.min} points allowed`
                      : `${tier.min}–${tier.max} points allowed`}
                </span>
                <span
                  className={`font-mono font-medium ${tier.milliPoints < 0 ? "text-red-400" : ""}`}
                >
                  {display(tier.milliPoints)}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      <WorkedExamples />

      <section className="rounded border border-white/10 p-6">
        <h2 className="mb-3 text-lg font-medium">Your starting lineup</h2>
        <p className="mb-4 text-sm text-white/60">
          Each week you start {NFL_PPR_ROSTER.starters.reduce((n, s) => n + s.count, 0)}{" "}
          players. Everyone else sits on your bench and scores nothing.
        </p>
        <div className="flex flex-wrap gap-2">
          {NFL_PPR_ROSTER.starters.flatMap((slot) =>
            Array.from({ length: slot.count }, (_, i) => (
              <span
                key={`${slot.slotType}-${i}`}
                className="rounded border border-white/15 px-3 py-1 font-mono text-sm"
              >
                {slot.slotType}
              </span>
            )),
          )}
        </div>
        <p className="mt-4 text-xs text-white/40">
          FLEX takes a running back, receiver, or tight end — whoever you think will score most.
        </p>
      </section>
    </div>
  );
}

/**
 * Worked examples, scored by the real engine.
 *
 * These call `scorePlayer` rather than stating a total, so the arithmetic on
 * this page cannot drift away from the arithmetic that decides matchups.
 */
function WorkedExamples() {
  const examples: { name: string; line: string; stats: StatLine[] }[] = [
    {
      name: "A receiver's big day",
      line: "8 catches, 112 yards, 1 touchdown",
      stats: [
        { statKey: "rec", value: 8 },
        { statKey: "rec_yd", value: 112 },
        { statKey: "rec_td", value: 1 },
      ],
    },
    {
      name: "A quarterback's ordinary day",
      line: "265 passing yards, 2 touchdowns, 1 interception, 18 rushing yards",
      stats: [
        { statKey: "pass_yd", value: 265 },
        { statKey: "pass_td", value: 2 },
        { statKey: "pass_int", value: 1 },
        { statKey: "rush_yd", value: 18 },
      ],
    },
    {
      name: "A running back who fumbled",
      line: "74 rushing yards, 3 catches for 21 yards, 1 lost fumble",
      stats: [
        { statKey: "rush_yd", value: 74 },
        { statKey: "rec", value: 3 },
        { statKey: "rec_yd", value: 21 },
        { statKey: "fum_lost", value: 1 },
      ],
    },
    {
      name: "A defense that shut them out",
      line: "0 points allowed, 4 sacks, 2 interceptions",
      stats: [
        { statKey: "def_pts_allowed", value: 0 },
        { statKey: "def_sack", value: 4 },
        { statKey: "def_int", value: 2 },
      ],
    },
  ];

  return (
    <section>
      <h2 className="mb-2 text-lg font-medium">Worked examples</h2>
      <p className="mb-4 max-w-2xl text-sm text-white/60">
        Scored by the same engine that scores your real matchups.
      </p>

      <div className="space-y-3">
        {examples.map((example) => (
          <div
            key={example.name}
            className="flex items-baseline justify-between rounded border border-white/10 px-4 py-3"
          >
            <div>
              <p className="text-sm font-medium">{example.name}</p>
              <p className="text-xs text-white/50">{example.line}</p>
            </div>
            <span className="font-mono text-lg">
              {formatPoints(scorePlayer(example.stats, RULES))}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
