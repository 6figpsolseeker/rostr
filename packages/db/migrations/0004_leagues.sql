-- Leagues and their frozen rules.

CREATE TYPE league_visibility AS ENUM ('PRIVATE', 'PUBLIC');

CREATE TYPE league_state AS ENUM (
  'FORMING',    -- accepting members, rules already frozen
  'DRAFTING',
  'IN_SEASON',
  'PLAYOFFS',
  'SETTLED',
  'DISSOLVED'
);

CREATE TABLE leagues (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sport_id         uuid NOT NULL REFERENCES sports (id),
  season           smallint NOT NULL,
  name             text NOT NULL CHECK (length(btrim(name)) > 0),
  visibility       league_visibility NOT NULL,
  commissioner_id  uuid NOT NULL REFERENCES users (id),
  -- SHA-256 of the canonical encoding of the rule set. This value goes on-chain;
  -- members sign it when they join.
  rules_hash       char(64) NOT NULL CHECK (rules_hash ~ '^[0-9a-f]{64}$'),
  -- Where the full rule document is pinned. The hash anchors it.
  rules_uri        text,
  state            league_state NOT NULL DEFAULT 'FORMING',
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX leagues_state_idx ON leagues (state);
CREATE INDEX leagues_public_idx ON leagues (season, state) WHERE visibility = 'PUBLIC';

-- ---------------------------------------------------------------------------
-- The frozen rule set
-- ---------------------------------------------------------------------------

-- Exactly one row per league, written once, never updated or deleted.
--
-- Application-layer immutability is a promise. Database-layer immutability is a
-- guarantee, and it survives a bug, a migration, or someone with psql access.
CREATE TABLE league_rules (
  league_id   uuid PRIMARY KEY REFERENCES leagues (id) ON DELETE RESTRICT,
  rule_json   jsonb NOT NULL,
  -- The exact canonical bytes that were hashed. Not a pretty-printed copy —
  -- re-hashing this string must reproduce `hash`.
  canonical   text NOT NULL,
  hash        char(64) NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$'),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION reject_rule_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'league_rules is immutable: rules are frozen at league creation and hashed on-chain (attempted % on league %)',
    TG_OP, COALESCE(OLD.league_id::text, 'unknown')
  USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER league_rules_immutable
  BEFORE UPDATE OR DELETE ON league_rules
  FOR EACH ROW EXECUTE FUNCTION reject_rule_mutation();

-- A league's hash must match the rules stored beside it.
CREATE FUNCTION check_rules_hash_matches() RETURNS trigger AS $$
DECLARE
  league_hash char(64);
BEGIN
  SELECT rules_hash INTO league_hash FROM leagues WHERE id = NEW.league_id;
  IF league_hash IS DISTINCT FROM NEW.hash THEN
    RAISE EXCEPTION
      'rules hash mismatch: league declares %, rule set hashes to %', league_hash, NEW.hash
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER league_rules_hash_matches
  BEFORE INSERT ON league_rules
  FOR EACH ROW EXECUTE FUNCTION check_rules_hash_matches();

-- ---------------------------------------------------------------------------
-- Denormalised rules, for querying
-- ---------------------------------------------------------------------------
-- These are a *copy* of the league's rules taken at creation, never a reference
-- to a shared template. If a default table were edited, every league pointing at
-- it would silently change — precisely what immutability exists to prevent.
--
-- `league_rules.rule_json` remains authoritative. These exist so the scoring
-- engine can join rather than parse JSON per row.

CREATE TABLE league_scoring_rules (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- RESTRICT, not CASCADE: the immutability trigger below would reject the
  -- cascaded delete anyway. Leagues are dissolved, never deleted.
  league_id              uuid NOT NULL REFERENCES leagues (id) ON DELETE RESTRICT,
  stat_key_id            uuid NOT NULL REFERENCES stat_keys (id),
  kind                   stat_kind NOT NULL,
  -- LINEAR only. Milli-points per unit; 1 point = 1000. Never a float.
  milli_points_per_unit  integer,
  -- TIERED only. Ordered, contiguous, ending unbounded.
  tiers                  jsonb,
  UNIQUE (league_id, stat_key_id),
  CONSTRAINT scoring_rule_shape CHECK (
    (kind = 'LINEAR' AND milli_points_per_unit IS NOT NULL AND tiers IS NULL)
    OR
    (kind = 'TIERED' AND tiers IS NOT NULL AND milli_points_per_unit IS NULL)
  )
);

CREATE TABLE league_roster_slots (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id     uuid NOT NULL REFERENCES leagues (id) ON DELETE RESTRICT,
  slot_type_id  uuid NOT NULL REFERENCES slot_types (id),
  count         smallint NOT NULL CHECK (count > 0),
  ordinal       smallint NOT NULL,
  UNIQUE (league_id, ordinal)
);

CREATE TRIGGER league_scoring_rules_immutable
  BEFORE UPDATE OR DELETE ON league_scoring_rules
  FOR EACH ROW EXECUTE FUNCTION reject_rule_mutation();

CREATE TRIGGER league_roster_slots_immutable
  BEFORE UPDATE OR DELETE ON league_roster_slots
  FOR EACH ROW EXECUTE FUNCTION reject_rule_mutation();
