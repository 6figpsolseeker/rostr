-- Trades belong to one league, and both sides of one belong to it too.
--
-- `proposeTrade` took the receiving team out of the request body and never
-- joined it to the league it was proposing in, and `acceptTrade` loaded a trade
-- by id alone and read its `league_id` only to fetch rules. So a manager holding
-- a team in two leagues could propose in one naming the other, accept it from
-- the far side, and let the hourly cron execute it — moving a player between two
-- closed player pools.
--
-- The damage is not a corrupt row, which is what makes it worth a constraint.
-- `roster_entries.league_id` is derived by 0022's trigger from the destination
-- team, so the imported row lands correctly stamped and satisfies
-- `roster_entries_one_owner_per_league`. It is indistinguishable from a
-- legitimate acquisition. And because `resolveTrade` releases with a direct
-- UPDATE rather than through `dropPlayer`, neither player touches
-- `waiver_wire` — so the receiving league's blind claim queue and priority
-- order are bypassed in both directions.
--
-- This is the same defect 0020 fixed for vetoes, in the same file, twenty lines
-- from the fix. Its comment is worth repeating: "the read is scoped now and the
-- write is refused, but neither repairs a row already written."
--
-- **Both prerequisites already exist.** 0020 added `teams_id_league_unique
-- (id, league_id)` for the veto's composite key, and `trades.league_id` has been
-- NOT NULL since 0005. So this needs no new column, no backfill and no trigger —
-- only the two constraints 0020 built the uniqueness for and did not use.
--
-- No repair step, unlike 0020. There is no production data yet (0022 says so for
-- the same reason), and a dirty row would make this ALTER fail loudly, which is
-- the right direction: the alternative is a DELETE, and `trade_assets` and
-- `trade_vetoes` both cascade from `trades`, so deleting an offending trade
-- would silently take the assets and the votes with it. For an EXECUTED trade
-- the roster moves survive the delete regardless, so it would destroy the only
-- record of a change it cannot undo. A human should look at such a row.
--
-- Forward-only, like every migration here.

ALTER TABLE trades
  ADD CONSTRAINT trades_proposer_in_league
  FOREIGN KEY (proposer_team_id, league_id) REFERENCES teams (id, league_id);

ALTER TABLE trades
  ADD CONSTRAINT trades_receiver_in_league
  FOREIGN KEY (receiver_team_id, league_id) REFERENCES teams (id, league_id);

-- Not closed here: `trade_assets.from_team_id` is a plain reference to
-- `teams (id)` with no `league_id` column of its own, so an asset row naming a
-- team in a third league stays representable. `resolveTrade` maps any
-- non-proposer `from_team_id` to the proposer, so such a row would move a
-- stranger's player. It is unreachable through `proposeTrade` now that both
-- trade teams are pinned, and closing it properly needs a column, a backfill and
-- a derive trigger — 0022's shape, not two ALTERs. Tracked separately.
