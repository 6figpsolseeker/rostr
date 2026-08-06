-- The draft order is drawn once, from randomness nobody could have predicted.
--
-- 0009 let the caller pass any seed and draw the order at league creation. That
-- is grindable, and grindable in a way that leaves no trace: a commissioner adds
-- a bot, computes the resulting order, removes it, adds a differently-identified
-- one, and repeats until the order suits them. Every order they computed is
-- provably correct. They simply kept rolling in private and announced the roll
-- they liked.
--
-- The fix is not a better shuffle. The shuffle was never the problem. The seed
-- has to be **unknowable until after the field is locked**, and the draw has to
-- be a one-time event nobody can repeat.
--
-- So:
--
--   * The seed comes from the first Solana block produced at or after the
--     league's frozen `scheduled_at`. It does not exist while teams are still
--     joining, so there is nothing to grind against; and once it exists anyone
--     can look up that slot and recompute the order.
--   * The slot and blockhash are recorded, so the draw is checkable by a
--     stranger rather than asserted by us.
--   * Triggers below make the draw and the resulting positions immutable, and
--     lock the field the instant the draw happens.

ALTER TABLE drafts ALTER COLUMN order_seed DROP NOT NULL;

ALTER TABLE drafts ADD COLUMN order_slot bigint;
ALTER TABLE drafts ADD COLUMN order_blockhash text;
ALTER TABLE drafts ADD COLUMN order_drawn_at timestamptz;

-- All four arrive together or not at all. A seed without the slot it came from
-- is exactly the unverifiable claim this whole change exists to remove.
ALTER TABLE drafts ADD CONSTRAINT order_drawn_together CHECK (
  (order_seed IS NULL AND order_slot IS NULL
     AND order_blockhash IS NULL AND order_drawn_at IS NULL)
  OR
  (order_seed IS NOT NULL AND order_slot IS NOT NULL
     AND order_blockhash IS NOT NULL AND order_drawn_at IS NOT NULL)
);

-- ---------------------------------------------------------------------------
-- Drawn once, and only once
-- ---------------------------------------------------------------------------

CREATE FUNCTION drafts_order_is_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.order_drawn_at IS NOT NULL AND (
       NEW.order_seed      IS DISTINCT FROM OLD.order_seed OR
       NEW.order_slot      IS DISTINCT FROM OLD.order_slot OR
       NEW.order_blockhash IS DISTINCT FROM OLD.order_blockhash OR
       NEW.order_drawn_at  IS DISTINCT FROM OLD.order_drawn_at
     ) THEN
    RAISE EXCEPTION
      'The draft order is drawn once, from slot % , and cannot be redrawn',
      OLD.order_slot;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER drafts_order_immutable
  BEFORE UPDATE ON drafts
  FOR EACH ROW EXECUTE FUNCTION drafts_order_is_immutable();

-- A position that could be edited after the draw would make the recorded slot
-- decorative: the order anyone recomputes would no longer be the order in play.
CREATE FUNCTION teams_draft_position_is_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.draft_position IS NOT NULL
     AND NEW.draft_position IS DISTINCT FROM OLD.draft_position THEN
    RAISE EXCEPTION
      'Team % already has draft position %; the order cannot be edited',
      OLD.id, OLD.draft_position;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER teams_draft_position_immutable
  BEFORE UPDATE ON teams
  FOR EACH ROW EXECUTE FUNCTION teams_draft_position_is_immutable();

-- ---------------------------------------------------------------------------
-- The field locks at the draw
-- ---------------------------------------------------------------------------

-- The shuffle depends on the seed *and on the set of teams*. Letting a team join
-- after the seed is known would restore the whole attack: watch the block land,
-- compute what adding a bot would do, then add it.
CREATE FUNCTION teams_locked_after_order_draw() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM drafts
     WHERE league_id = NEW.league_id AND order_drawn_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'League % has already drawn its draft order; the field is locked',
      NEW.league_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER teams_locked_after_draw
  BEFORE INSERT ON teams
  FOR EACH ROW EXECUTE FUNCTION teams_locked_after_order_draw();

CREATE INDEX drafts_undrawn_idx ON drafts (scheduled_at) WHERE order_drawn_at IS NULL;
