-- A trade's assets come from teams in the trade's own league. Issue #111.
--
-- `0026` pinned both of a trade's teams to its league and said what it left
-- open: `trade_assets.from_team_id` is a plain reference to `teams (id)` and the
-- table has no `league_id` to pin it against, so an asset naming a team in a
-- third league stays representable. `resolveTrade` treats any `from_team_id`
-- that is not the proposer as the receiver's, so such a row would release a
-- player from a roster nobody in the trade owns.
--
-- Not reachable today: `proposeTrade` writes assets only for the two teams it
-- has already bound. This closes it for a future writer, as `0048` did for
-- waiver claims.
--
-- `0022`'s shape, because the column does not exist yet: add it, backfill it,
-- derive it by trigger, then pin the pair with a composite foreign key onto
-- `teams_id_league_unique` (`0020`).
--
-- **Derived from `trades`, never supplied.** A caller's value is overwritten
-- rather than checked, exactly as `0022` does — so an insert naming the wrong
-- league is corrected silently, and it is the foreign key that then refuses a
-- team outside it. Nothing here can be satisfied by passing the right number.
--
-- No ON DELETE clause, following `0026` and `0048`: the existing reference to
-- `teams (id)` already restricts, and a cascade here would turn that refusal
-- into silent deletion.
--
-- No repair step, following `0026`. A dirty row makes the final ALTER fail with
-- the pair named; deleting it would cascade nowhere useful and destroy the only
-- record of a move an EXECUTED trade cannot undo. A human should look at it.
--
-- Forward-only, like every migration here.

ALTER TABLE trade_assets
  ADD COLUMN league_id uuid;

UPDATE trade_assets a
   SET league_id = t.league_id
  FROM trades t
 WHERE t.id = a.trade_id;

ALTER TABLE trade_assets
  ALTER COLUMN league_id SET NOT NULL;

CREATE FUNCTION trade_assets_league_from_trade() RETURNS trigger AS $$
DECLARE
  trade_league uuid;
BEGIN
  SELECT t.league_id INTO trade_league FROM trades t WHERE t.id = NEW.trade_id;
  IF trade_league IS NULL THEN
    RAISE EXCEPTION 'trade_assets.trade_id % names no trade', NEW.trade_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  NEW.league_id := trade_league;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trade_assets_league_derived
  BEFORE INSERT OR UPDATE OF trade_id, league_id ON trade_assets
  FOR EACH ROW EXECUTE FUNCTION trade_assets_league_from_trade();

ALTER TABLE trade_assets
  ADD CONSTRAINT trade_assets_from_team_in_league
  FOREIGN KEY (from_team_id, league_id) REFERENCES teams (id, league_id);
