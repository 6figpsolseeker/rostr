import type { LeagueRules, ScoringRule } from "@rostr/core";

/**
 * The full rule set, rendered for a human.
 *
 * This component is the product's central promise. "Rules are shown before you
 * join" is only true if everything binding is actually on screen — so nothing
 * here is collapsed behind a "show advanced" toggle, and no field is omitted
 * because it seemed unimportant.
 */
export function RulesView({ rules, hash }: { rules: LeagueRules; hash: string }) {
  return (
    <div className="space-y-8">
      <Banner hash={hash} />
      <Scoring rules={rules} />
      <Roster rules={rules} />
      <League rules={rules} />
      <Season rules={rules} />
      <Transactions rules={rules} />
      <Pot rules={rules} />
      <Governance rules={rules} />
    </div>
  );
}

function Banner({ hash }: { hash: string }) {
  return (
    <div className="rounded border border-nocturne-accent/40 border border-nocturne-accent/5 p-4">
      <p className="text-sm">
        These rules are <strong>final</strong>. They cannot be changed by anyone, including the
        commissioner, for the life of this league.
      </p>
      <p className="mt-2 font-mono text-xs break-all text-nocturne-neutral-500">{hash}</p>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-3 text-sm font-semibold tracking-wide text-nocturne-neutral-500 uppercase">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between border-b border-nocturne-neutral-900 py-1.5 text-sm">
      <span className="text-nocturne-neutral-400">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
  );
}

/** Milli-points back to a readable number. Display only — never arithmetic. */
function points(milli: number): string {
  const value = milli / 1000;
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0$/, "");
}

const STAT_LABELS: Record<string, string> = {
  pass_yd: "Passing yards",
  pass_td: "Passing TD",
  pass_int: "Interception thrown",
  rush_yd: "Rushing yards",
  rush_td: "Rushing TD",
  rec: "Reception",
  rec_yd: "Receiving yards",
  rec_td: "Receiving TD",
  fum_lost: "Fumble lost",
  two_pt: "2-point conversion",
  fg_0_39: "Field goal 0–39",
  fg_40_49: "Field goal 40–49",
  fg_50_plus: "Field goal 50+",
  xp_made: "Extra point",
  def_sack: "Sack",
  def_int: "Defensive interception",
  def_fum_rec: "Fumble recovery",
  def_safety: "Safety",
  def_td: "Defensive/ST TD",
  def_blk_kick: "Blocked kick",
  def_pts_allowed: "Points allowed",
};

function Scoring({ rules }: { rules: LeagueRules }) {
  const linear = rules.scoring.filter(
    (r): r is Extract<ScoringRule, { kind: "LINEAR" }> => r.kind === "LINEAR",
  );
  const tiered = rules.scoring.filter(
    (r): r is Extract<ScoringRule, { kind: "TIERED" }> => r.kind === "TIERED",
  );

  return (
    <Section title="Scoring">
      <div className="grid gap-x-8 sm:grid-cols-2">
        {linear.map((rule) => (
          <Row
            key={rule.statKey}
            label={STAT_LABELS[rule.statKey] ?? rule.statKey}
            value={points(rule.milliPointsPerUnit)}
          />
        ))}
      </div>

      {tiered.map((rule) => (
        <div key={rule.statKey} className="mt-4">
          <p className="mb-2 text-sm text-nocturne-neutral-400">
            {STAT_LABELS[rule.statKey] ?? rule.statKey}
          </p>
          <div className="grid gap-x-8 sm:grid-cols-2">
            {rule.tiers.map((tier) => (
              <Row
                key={`${tier.min}-${tier.max ?? "up"}`}
                label={tier.max === null ? `${tier.min}+` : `${tier.min}–${tier.max}`}
                value={points(tier.milliPoints)}
              />
            ))}
          </div>
        </div>
      ))}
    </Section>
  );
}

function Roster({ rules }: { rules: LeagueRules }) {
  return (
    <Section title="Roster">
      <div className="grid gap-x-8 sm:grid-cols-2">
        {rules.roster.starters.map((slot) => (
          <Row key={slot.slotType} label={slot.slotType} value={slot.count} />
        ))}
        <Row label="Bench" value={rules.roster.benchSlots} />
        <Row label="Injured reserve" value={rules.roster.irSlots} />
        <Row
          label="Lineup locks"
          value={
            rules.roster.lockMode === "PER_PLAYER_KICKOFF"
              ? "At each player's kickoff"
              : "At the week's first kickoff"
          }
        />
      </div>
    </Section>
  );
}

/**
 * League size and who may occupy a seat.
 *
 * The bot rule is here rather than buried in a help page because it is a
 * guarantee, not a setting: a league with a pot cannot hold one, and that is
 * part of what a member signs. A rule nobody can read before joining is not
 * really a rule they agreed to.
 */
function League({ rules }: { rules: LeagueRules }) {
  const l = rules.league;

  return (
    <Section title="League">
      <div className="grid gap-x-8 sm:grid-cols-2">
        <Row label="Teams" value={`Up to ${l.maxTeams}`} />
        <Row label="Minimum managers" value={String(l.minHumans)} />
        <Row
          label="Visibility"
          value={l.visibility === "PRIVATE" ? "Invite only" : "Anyone can join"}
        />
        <Row
          label="Bots"
          value={
            l.maxBots === 0
              ? rules.pot
                ? "None — a bot cannot be paid, so a league with a pot cannot hold one"
                : "None"
              : `At most ${l.maxBots}, and only to square an odd number of managers`
          }
        />
      </div>
    </Section>
  );
}

function Season({ rules }: { rules: LeagueRules }) {
  const s = rules.schedule;
  return (
    <Section title="Season">
      <div className="grid gap-x-8 sm:grid-cols-2">
        <Row label="Regular season" value={`Weeks 1–${s.regularSeasonWeeks}`} />
        <Row label="Playoffs" value={`Weeks ${s.playoffWeeks.join(", ")}`} />
        <Row label="Playoff teams" value={`${s.playoffTeams} of ${rules.league.maxTeams}`} />
        <Row label="First-round byes" value={`Top ${s.byeSeeds} seeds`} />
        <Row label="Consolation bracket" value={s.consolationBracket ? "Yes" : "No"} />
        <Row label="Tiebreakers" value={s.tiebreakers.join(" → ")} />
      </div>
    </Section>
  );
}

function Transactions({ rules }: { rules: LeagueRules }) {
  return (
    <Section title="Transactions">
      <div className="grid gap-x-8 sm:grid-cols-2">
        <Row
          label="Waivers"
          value={
            rules.waivers.system === "ROLLING_PRIORITY"
              ? "Rolling priority"
              : rules.waivers.system
          }
        />
        <Row label="Waiver period" value={`${rules.waivers.waiverPeriodDays} days`} />
        <Row label="Trades" value={rules.trades.enabled ? "Enabled" : "Disabled"} />
        <Row label="Trade deadline" value={`End of week ${rules.trades.deadlineWeek}`} />
        <Row label="Veto window" value={`${rules.trades.vetoWindowHours} hours`} />
        <Row
          label="Veto threshold"
          value={`${rules.trades.vetoNumerator}/${rules.trades.vetoDenominator} of uninvolved teams`}
        />
        <Row label="Draft" value={`Snake, ${rules.draft.mode.toLowerCase()}`} />
        <Row
          label="Pick clock"
          value={
            rules.draft.pickSeconds >= 3600
              ? `${rules.draft.pickSeconds / 3600} hours`
              : `${rules.draft.pickSeconds} seconds`
          }
        />
        <Row
          label="Draft time"
          value={new Date(rules.draft.scheduledAt * 1000).toLocaleString()}
        />
      </div>
    </Section>
  );
}

function Pot({ rules }: { rules: LeagueRules }) {
  if (rules.pot === null) {
    return (
      <Section title="Prize pool">
        <p className="text-sm text-nocturne-neutral-400">
          This league plays for nothing. No buy-in, no escrow, no payouts.
        </p>
      </Section>
    );
  }

  const pot = rules.pot;
  return (
    <Section title="Prize pool">
      <div className="grid gap-x-8 sm:grid-cols-2">
        <Row label="Buy-in" value={`${pot.buyInBaseUnits} base units`} />
        <Row
          label="Token"
          value={<span className="font-mono text-xs break-all">{pot.tokenMint}</span>}
        />
        <Row
          label="Refund unlocks"
          value={new Date(pot.refundUnlockAt * 1000).toLocaleDateString()}
        />
      </div>
      <div className="mt-4 grid gap-x-8 sm:grid-cols-2">
        {pot.payout.map((share) => (
          <Row
            key={share.prize}
            label={share.prize.replace(/_/g, " ").toLowerCase()}
            value={`${share.basisPoints / 100}%`}
          />
        ))}
      </div>
      <p className="mt-3 text-xs text-nocturne-neutral-500">
        Funds are held in escrow until the season resolves. After the refund unlock date any
        member may withdraw their own stake unilaterally, regardless of league state.
      </p>
    </Section>
  );
}

function Governance({ rules }: { rules: LeagueRules }) {
  return (
    <Section title="Autofill and settlement">
      <div className="grid gap-x-8 sm:grid-cols-2">
        {/*
          Worth stating rather than leaving to be discovered: there is no
          penalty for missing a week. The rule that used to take a stake for it
          is gone, and a member reading these rules before they sign should see
          that plainly.
        */}
        <Row
          label="Empty slots filled by"
          value={
            rules.roster.autofill === "WEEKLY_PROJECTION"
              ? "This week's projection"
              : "Season-to-date average"
          }
        />
        <Row label="Penalty for missing a week" value="None" />
        <Row label="Oracle sources" value={rules.settlement.requiredOracleSources} />
        <Row
          label="Weeks finalise after"
          value={`${rules.settlement.standardFinalizationHours}h`}
        />
        <Row
          label="Paying weeks finalise after"
          value={`${rules.settlement.payingFinalizationHours}h`}
        />
        {/*
          Labelled by what the field does rather than by its name. Every prize is
          paid once, after the championship — these are the weeks that *decide*
          one and therefore wait the full stat-correction window. "Paying weeks"
          above a join button would promise money moving in December.
        */}
        <Row
          label="Weeks that wait for stat corrections"
          value={rules.settlement.payingWeeks.join(", ")}
        />
      </div>
    </Section>
  );
}
