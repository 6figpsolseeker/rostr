-- A fixture whose kickoff time the NFL has not fixed yet.
--
-- The NFL holds back the kickoff *times* of its late-December games for flex
-- scheduling, and `syncGames` skipped any game the provider gave no time —
-- deliberately, because a game stored at the epoch locks every lineup in it at
-- 1970. The reasoning was right; what it discarded was not. The provider sends
-- the date, the opponent and the fixture's existence alongside the missing time,
-- and all three went in the bin with it.
--
-- Measured on the deployed database, 2026-08-17: `games` held 248 fixtures for
-- weeks 1-17 against a correct 256, with weeks **16 and 17** each four short.
-- Those are the playoff and championship weeks. A player whose team has no game
-- has no stat line, and an absent stat line scores zero — correctly, by
-- `results.ts`'s own rules — so a championship could have been decided by eight
-- teams' players scoring nothing, with nothing raising an error and
-- `weekHasSchedule` answering true off the twelve games that did exist.
--
-- **`kickoff_at` stays NOT NULL, and that is the whole shape of this fix.** It
-- is read as a real timestamp by the lineup lock, the game watcher,
-- `weekFirstKickoff`, the scoreboard and the box-score sweep. Making it nullable
-- would push a null check into every one of them, and the cost of missing one is
-- a slot that never locks — the exact defect `loadKickoffs` was rewritten to
-- close. So the row carries a genuine, conservative timestamp and a flag saying
-- the time is provisional.
--
-- **The conservative time is derived, never invented.** `syncGames` takes the
-- earliest kickoff among already-dated games on the same calendar date — for 27
-- December, the 13:00 ET Sunday slot, which is the earliest hour the pending
-- game could start. A fixture with no dated sibling on its date is still
-- skipped, so this only ever stores a game whose lock time comes from data.
--
-- Locking early is the safe direction and is chosen deliberately. It costs a
-- manager some Sunday-morning flexibility on one player; the opposite error lets
-- someone start a player after watching him score, which is the entire reason
-- the lock exists.

ALTER TABLE games
  ADD COLUMN kickoff_tbd boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN games.kickoff_tbd IS
  'True when the provider has given this fixture a date but not a kickoff time, '
  'so kickoff_at holds a conservative earliest-possible time rather than the '
  'real one. Locks may use it as-is; screens must not present it as fact, and '
  'must not read the clock passing it as the game having started.';
