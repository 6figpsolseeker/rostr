-- Sport registry.
--
-- Sports are rows, never tables. Adding basketball inserts into these four
-- tables and writes one provider adapter; it does not alter any structure.
-- No column in this file may name a football concept.

CREATE TABLE sports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key           text NOT NULL UNIQUE,
  display_name  text NOT NULL,
  season_weeks  smallint NOT NULL CHECK (season_weeks > 0),
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- LINEAR: points = value x multiplier.
-- TIERED: points = lookup(value in range). Used where the relationship is a step
-- function rather than a rate.
CREATE TYPE stat_kind AS ENUM ('LINEAR', 'TIERED');

CREATE TABLE stat_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sport_id      uuid NOT NULL REFERENCES sports (id) ON DELETE CASCADE,
  key           text NOT NULL,
  display_name  text NOT NULL,
  kind          stat_kind NOT NULL,
  UNIQUE (sport_id, key)
);

CREATE TABLE positions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sport_id      uuid NOT NULL REFERENCES sports (id) ON DELETE CASCADE,
  key           text NOT NULL,
  display_name  text NOT NULL,
  sort_order    smallint NOT NULL,
  UNIQUE (sport_id, key)
);

-- A multi-position slot (football's FLEX, basketball's G) lists several eligible
-- positions. Nothing in the schema or the engine learns that certain positions
-- are interchangeable — it reads the list.
CREATE TABLE slot_types (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sport_id      uuid NOT NULL REFERENCES sports (id) ON DELETE CASCADE,
  key           text NOT NULL,
  display_name  text NOT NULL,
  UNIQUE (sport_id, key)
);

CREATE TABLE slot_type_positions (
  slot_type_id  uuid NOT NULL REFERENCES slot_types (id) ON DELETE CASCADE,
  position_id   uuid NOT NULL REFERENCES positions (id) ON DELETE CASCADE,
  PRIMARY KEY (slot_type_id, position_id)
);

CREATE INDEX stat_keys_sport_idx ON stat_keys (sport_id);
CREATE INDEX positions_sport_idx ON positions (sport_id);
CREATE INDEX slot_types_sport_idx ON slot_types (sport_id);
