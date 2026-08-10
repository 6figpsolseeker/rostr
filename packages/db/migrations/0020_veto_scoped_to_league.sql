-- Vetoes belong to the trade's own league.
--
-- `vetoTrade` looked the voting team up by id alone, so a team in a *different*
-- league could cast a counted vote: the tally rose while the electorate — scoped
-- to the trade's league — did not. Enough of those force a veto the league never
-- wanted, which in a pot league moves money.
--
-- The read is scoped now and the write is refused, but neither repairs a row
-- already written, and `trade_vetoes.team_id` is `ON DELETE RESTRICT`, so such a
-- row cannot be cleared by deleting the team either. Hence this.
--
-- Forward-only, like every migration here: the answer to a bad row is another
-- migration, not a rollback.

DELETE FROM trade_vetoes v
      USING trades t, teams voter
      WHERE v.trade_id = t.id
        AND voter.id = v.team_id
        AND (
              voter.league_id <> t.league_id
           OR voter.is_bot
           OR voter.id = t.proposer_team_id
           OR voter.id = t.receiver_team_id
        );

-- And stop it at the table, so no future writer has to remember.
--
-- A CHECK cannot span tables, and a trigger is the wrong shape for a rule this
-- flat, so this is a foreign key onto a uniqueness that already holds: a veto's
-- (trade, team) pair is only legal when the team is in the trade's league.
-- Expressing it needs the league on both sides, so `trade_vetoes` carries the
-- league it was cast in and the pair is checked against `teams`.
ALTER TABLE trade_vetoes
  ADD COLUMN IF NOT EXISTS league_id uuid REFERENCES leagues (id);

UPDATE trade_vetoes v
   SET league_id = t.league_id
  FROM trades t
 WHERE v.trade_id = t.id
   AND v.league_id IS NULL;

ALTER TABLE trade_vetoes
  ALTER COLUMN league_id SET NOT NULL;

-- `teams` already has a unique (id) as its primary key; this composite unique is
-- what lets the veto reference (team, league) together rather than team alone.
ALTER TABLE teams
  ADD CONSTRAINT teams_id_league_unique UNIQUE (id, league_id);

ALTER TABLE trade_vetoes
  ADD CONSTRAINT trade_vetoes_voter_in_league
  FOREIGN KEY (team_id, league_id) REFERENCES teams (id, league_id);

-- The trade's league and the vote's league are the same one.
ALTER TABLE trades
  ADD CONSTRAINT trades_id_league_unique UNIQUE (id, league_id);

ALTER TABLE trade_vetoes
  ADD CONSTRAINT trade_vetoes_trade_in_league
  FOREIGN KEY (trade_id, league_id) REFERENCES trades (id, league_id);
