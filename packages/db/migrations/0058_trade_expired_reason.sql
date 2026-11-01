-- Why a trade expired. Issue #121.
--
-- Two paths write `EXPIRED` and they mean different things. `DEADLINE`: the
-- veto window closed past the trade deadline, rosters untouched, nobody's
-- fault — the case `RULES.md` defines. `ASSET_GONE`: a player one side promised
-- was no longer on the roster at execution. Every route to that is meant to be
-- closed upstream, so when it fires it means an upstream guard failed, and that
-- is exactly when the record must say which.
--
-- Before this, the two were the same row. `tradeCannotExecute`'s docstring
-- claimed a reader could tell them apart; nothing stored could.
--
-- Null for every state but EXPIRED, and for a trade that expired before this
-- column existed — its reason was never recorded and is not guessed here.
--
-- Forward-only, like every migration here.

ALTER TABLE trades
  ADD COLUMN expired_reason text
    CONSTRAINT trades_expired_reason_valid CHECK (expired_reason IN ('DEADLINE', 'ASSET_GONE')),
  ADD CONSTRAINT trades_expired_reason_only_when_expired
    CHECK (expired_reason IS NULL OR state = 'EXPIRED');
