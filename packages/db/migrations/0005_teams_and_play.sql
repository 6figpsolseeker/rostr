-- Teams, rosters, lineups, and play.

CREATE TABLE teams (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id         uuid NOT NULL REFERENCES leagues (id) ON DELETE RESTRICT,
  -- A bot is a team without an owner, not a separate entity. Keeps every
  -- standing, matchup, and roster query uniform.
  owner_id          uuid REFERENCES users (id),
  is_bot            boolean NOT NULL DEFAULT false,
  name              text NOT NULL CHECK (length(btrim(name)) > 0),
  -- 1..N within the league, assigned at join. This is the "team id" the
  -- LOWEST_TEAM_ID tiebreaker refers to: a UUID has no meaningful order, and the
  -- final tiebreaker must be deterministic when money is at stake.
  slot              smallint NOT NULL CHECK (slot > 0),
  draft_position    smallint,
  waiver_priority   smallint,
  strikes           smallint NOT NULL DEFAULT 0 CHECK (strikes >= 0),
  abandoned_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (league_id, slot),
  UNIQUE (league_id, draft_position),
  CONSTRAINT bot_has_no_owner CHECK ((is_bot AND owner_id IS NULL) OR (NOT is_bot AND owner_id IS NOT NULL))
);

CREATE INDEX teams_league_idx ON teams (league_id);
CREATE INDEX teams_owner_idx ON teams (owner_id);

-- A member's cryptographic consent to the rule set. Not a checkbox: a signature
-- over the rules hash, so what they agreed to is provable after the fact.
CREATE TABLE league_memberships (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id    uuid NOT NULL REFERENCES leagues (id) ON DELETE RESTRICT,
  user_id      uuid NOT NULL REFERENCES users (id),
  team_id      uuid NOT NULL REFERENCES teams (id),
  wallet_id    uuid NOT NULL REFERENCES wallets (id),
  rules_hash   char(64) NOT NULL,
  signature    text NOT NULL,
  joined_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (league_id, user_id),
  UNIQUE (team_id)
);

-- ---------------------------------------------------------------------------
-- Rosters
-- ---------------------------------------------------------------------------

CREATE TYPE acquisition_method AS ENUM ('DRAFT', 'WAIVER', 'FREE_AGENT', 'TRADE');

-- Append-only with released_at, so any past week's roster is reconstructible.
CREATE TABLE roster_entries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id       uuid NOT NULL REFERENCES teams (id) ON DELETE RESTRICT,
  player_id     uuid NOT NULL REFERENCES players (id),
  acquired_via  acquisition_method NOT NULL,
  acquired_at   timestamptz NOT NULL DEFAULT now(),
  released_at   timestamptz
);

CREATE INDEX roster_entries_team_idx ON roster_entries (team_id) WHERE released_at IS NULL;
CREATE INDEX roster_entries_player_idx ON roster_entries (player_id);

-- A player may sit on only one active roster per league at a time.
CREATE UNIQUE INDEX roster_entries_one_owner
  ON roster_entries (team_id, player_id)
  WHERE released_at IS NULL;

-- What was actually started, recorded rather than derived after the fact. A
-- settled week must be provable.
CREATE TABLE lineups (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id       uuid NOT NULL REFERENCES teams (id) ON DELETE RESTRICT,
  week          smallint NOT NULL,
  slot_type_id  uuid NOT NULL REFERENCES slot_types (id),
  slot_index    smallint NOT NULL,
  player_id     uuid REFERENCES players (id),
  locked_at     timestamptz,
  UNIQUE (team_id, week, slot_type_id, slot_index)
);

CREATE INDEX lineups_week_idx ON lineups (team_id, week);

-- ---------------------------------------------------------------------------
-- Play
-- ---------------------------------------------------------------------------

-- Regular season, playoff bracket, and consolation bracket are structurally
-- identical: two teams and a week. One table.
CREATE TYPE matchup_phase AS ENUM ('REGULAR', 'PLAYOFF', 'CONSOLATION');

CREATE TABLE matchups (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id      uuid NOT NULL REFERENCES leagues (id) ON DELETE RESTRICT,
  week           smallint NOT NULL,
  phase          matchup_phase NOT NULL DEFAULT 'REGULAR',
  round          smallint,
  home_team_id   uuid REFERENCES teams (id),
  away_team_id   uuid REFERENCES teams (id),
  -- Milli-points. Never a float.
  home_milli_points  integer,
  away_milli_points  integer,
  finalized_at   timestamptz,
  CONSTRAINT distinct_teams CHECK (home_team_id IS DISTINCT FROM away_team_id)
);

CREATE INDEX matchups_league_week_idx ON matchups (league_id, week);

-- ---------------------------------------------------------------------------
-- Transactions
-- ---------------------------------------------------------------------------

CREATE TYPE trade_state AS ENUM (
  'PROPOSED',
  'ACCEPTED',    -- both sides agreed; assets in escrow, veto window open
  'VETOED',
  'EXECUTED',
  'WITHDRAWN',
  'EXPIRED'
);

CREATE TABLE trades (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id           uuid NOT NULL REFERENCES leagues (id) ON DELETE RESTRICT,
  proposer_team_id    uuid NOT NULL REFERENCES teams (id),
  receiver_team_id    uuid NOT NULL REFERENCES teams (id),
  state               trade_state NOT NULL DEFAULT 'PROPOSED',
  escrow_pda          text,
  veto_deadline       timestamptz,
  proposed_at         timestamptz NOT NULL DEFAULT now(),
  resolved_at         timestamptz,
  CONSTRAINT distinct_trade_teams CHECK (proposer_team_id <> receiver_team_id)
);

CREATE TABLE trade_assets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_id      uuid NOT NULL REFERENCES trades (id) ON DELETE CASCADE,
  from_team_id  uuid NOT NULL REFERENCES teams (id),
  player_id     uuid NOT NULL REFERENCES players (id),
  UNIQUE (trade_id, player_id)
);

-- Only uninvolved teams may vote, and bots never do. Enforced in application
-- logic against league membership; the unique constraint stops double votes.
CREATE TABLE trade_vetoes (
  trade_id    uuid NOT NULL REFERENCES trades (id) ON DELETE CASCADE,
  team_id     uuid NOT NULL REFERENCES teams (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (trade_id, team_id)
);

CREATE INDEX trades_league_state_idx ON trades (league_id, state);
CREATE INDEX trades_veto_deadline_idx ON trades (veto_deadline) WHERE state = 'ACCEPTED';

CREATE TYPE waiver_claim_state AS ENUM ('PENDING', 'AWARDED', 'FAILED', 'CANCELLED');

CREATE TABLE waiver_claims (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id        uuid NOT NULL REFERENCES leagues (id) ON DELETE RESTRICT,
  team_id          uuid NOT NULL REFERENCES teams (id),
  add_player_id    uuid NOT NULL REFERENCES players (id),
  drop_player_id   uuid REFERENCES players (id),
  priority_at_claim smallint,
  state            waiver_claim_state NOT NULL DEFAULT 'PENDING',
  created_at       timestamptz NOT NULL DEFAULT now(),
  processed_at     timestamptz
);

CREATE INDEX waiver_claims_pending_idx ON waiver_claims (league_id, state) WHERE state = 'PENDING';

-- Players sit on waivers for a fixed period after being dropped before becoming
-- free agents. Cleared when the period elapses.
CREATE TABLE waiver_wire (
  league_id     uuid NOT NULL REFERENCES leagues (id) ON DELETE RESTRICT,
  player_id     uuid NOT NULL REFERENCES players (id),
  clears_at     timestamptz NOT NULL,
  PRIMARY KEY (league_id, player_id)
);
