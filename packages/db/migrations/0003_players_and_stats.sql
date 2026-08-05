-- Players and stat lines.
--
-- Shared across every league: one box score is ingested once and scored against
-- every league in the system. Data cost is O(games), not O(users).

CREATE TABLE players (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sport_id              uuid NOT NULL REFERENCES sports (id) ON DELETE CASCADE,
  -- The provider's identifier. Kept so a player can be re-matched after a
  -- provider switch without guessing from names.
  external_ref          text NOT NULL,
  full_name             text NOT NULL,
  primary_position_id   uuid NOT NULL REFERENCES positions (id),
  team_ref              text,
  status                text NOT NULL DEFAULT 'ACTIVE',
  active                boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sport_id, external_ref)
);

-- Multi-position eligibility is a property of the player, not a relationship
-- between two entities — but it still needs referential integrity, so it lives
-- here rather than in an array column.
CREATE TABLE player_eligible_positions (
  player_id    uuid NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  position_id  uuid NOT NULL REFERENCES positions (id) ON DELETE CASCADE,
  PRIMARY KEY (player_id, position_id)
);

CREATE TABLE player_seasons (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id  uuid NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  season     smallint NOT NULL,
  team_ref   text,
  bye_week   smallint,
  UNIQUE (player_id, season)
);

-- Append-only, versioned.
--
-- The NFL issues official stat corrections for up to seven days after a game. A
-- settled week must remain auditable against exactly the data it settled on, so
-- corrections insert a new revision rather than overwriting the old one.
CREATE TABLE stat_lines (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  player_id     uuid NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  season        smallint NOT NULL,
  week          smallint NOT NULL,
  stat_key_id   uuid NOT NULL REFERENCES stat_keys (id),
  value         integer NOT NULL,
  revision      integer NOT NULL DEFAULT 0,
  source        text NOT NULL,
  observed_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (player_id, season, week, stat_key_id, source, revision)
);

CREATE INDEX stat_lines_week_idx ON stat_lines (season, week);
CREATE INDEX stat_lines_player_week_idx ON stat_lines (player_id, season, week);

-- The current value of a stat is its highest revision from a given source.
CREATE VIEW stat_lines_current AS
SELECT DISTINCT ON (player_id, season, week, stat_key_id, source)
  id, player_id, season, week, stat_key_id, value, revision, source, observed_at
FROM stat_lines
ORDER BY player_id, season, week, stat_key_id, source, revision DESC;

-- Game schedule. Kickoff times drive every automated job: lineup locks, the
-- inactives fetch at T-100min, and the game watcher that starts at T+2.5h.
CREATE TABLE games (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sport_id      uuid NOT NULL REFERENCES sports (id) ON DELETE CASCADE,
  external_ref  text NOT NULL,
  season        smallint NOT NULL,
  week          smallint NOT NULL,
  home_team_ref text NOT NULL,
  away_team_ref text NOT NULL,
  kickoff_at    timestamptz NOT NULL,
  status        text NOT NULL DEFAULT 'SCHEDULED',
  final_at      timestamptz,
  UNIQUE (sport_id, external_ref)
);

CREATE INDEX games_kickoff_idx ON games (kickoff_at);
CREATE INDEX games_week_idx ON games (season, week);
