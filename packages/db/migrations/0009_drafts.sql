-- The draft, persisted.
--
-- The draft is a pure state machine in `@rostr/core` and stays that way. This
-- schema is its storage and, more importantly, its **referee**: the state
-- machine is single-threaded and cannot arbitrate between two managers who click
-- at the same instant. The constraints below can.

CREATE TYPE draft_status AS ENUM (
  'SCHEDULED',    -- order assigned, clock not started
  'IN_PROGRESS',
  'PAUSED',       -- commissioner halt; the clock does not run
  'COMPLETE'
);

-- Mirrors `DraftPick["source"]` in @rostr/core. The TypeScript side imports that
-- type rather than restating it, so a new source cannot be added there without
-- this enum failing loudly.
CREATE TYPE draft_pick_source AS ENUM (
  'MANUAL',         -- a human chose it
  'QUEUE',          -- clock expired, taken from the manager's queue
  'NEED',           -- best player at the team's most-needed slot
  'BEST_AVAILABLE'
);

CREATE TABLE drafts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- One draft per league. A re-draft would invalidate every roster NFT already
  -- minted, so there is no second one.
  league_id         uuid NOT NULL UNIQUE REFERENCES leagues (id) ON DELETE RESTRICT,
  status            draft_status NOT NULL DEFAULT 'SCHEDULED',
  rounds            smallint NOT NULL CHECK (rounds > 0),
  -- Seconds per pick, copied from the frozen rules so the clock cannot be
  -- changed mid-draft by editing anything.
  pick_seconds      integer NOT NULL CHECK (pick_seconds >= 90),
  -- The seed the order was derived from, recorded so anyone can recompute the
  -- order and confirm it was not reshuffled. See `generateDraftOrder`.
  order_seed        char(64) NOT NULL,
  scheduled_at      timestamptz NOT NULL,
  -- When the pick currently on the clock started. NULL unless IN_PROGRESS.
  clock_started_at  timestamptz,
  started_at        timestamptz,
  completed_at      timestamptz,
  CONSTRAINT clock_only_while_running
    CHECK ((status = 'IN_PROGRESS') = (clock_started_at IS NOT NULL))
);

-- Append-only. A pick is never updated or deleted: the draft is the origin of
-- every roster in the league and its history has to stay reconstructible.
CREATE TABLE draft_picks (
  draft_id     uuid NOT NULL REFERENCES drafts (id) ON DELETE RESTRICT,
  -- 1-based, straight through every round.
  pick_number  smallint NOT NULL CHECK (pick_number > 0),
  round        smallint NOT NULL CHECK (round > 0),
  team_id      uuid NOT NULL REFERENCES teams (id),
  player_id    uuid NOT NULL REFERENCES players (id),
  source       draft_pick_source NOT NULL,
  made_at      timestamptz NOT NULL DEFAULT now(),

  -- Two managers clicking at the same moment both compute "I am pick 15". The
  -- application cannot prevent that; this can. The second INSERT fails.
  PRIMARY KEY (draft_id, pick_number),

  -- And the same player cannot go twice, however the race arrives.
  UNIQUE (draft_id, player_id)
);

CREATE INDEX draft_picks_team_idx ON draft_picks (draft_id, team_id);

-- A manager's personal ordered list, used when their clock expires.
--
-- Rows are deleted and rewritten wholesale on reorder rather than patched, so
-- there is no window in which a queue is half-updated.
CREATE TABLE draft_queues (
  team_id    uuid NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  player_id  uuid NOT NULL REFERENCES players (id),
  -- 1-based. Deferrable so a reorder can pass through a transient duplicate
  -- inside a transaction without being rejected mid-write.
  rank       smallint NOT NULL CHECK (rank > 0),
  PRIMARY KEY (team_id, player_id),
  CONSTRAINT draft_queues_rank_unique UNIQUE (team_id, rank) DEFERRABLE INITIALLY DEFERRED
);

-- The draft order lives on `teams.draft_position`, which already exists and is
-- already UNIQUE per league. Duplicating it here would create two sources of
-- truth for who is on the clock.
--
-- It is nullable there because a team joins before the order is drawn. Once a
-- draft exists, every team in that league must have one — enforced in
-- `assignDraftOrder`, which writes them all in a single transaction.
