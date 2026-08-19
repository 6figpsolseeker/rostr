-- The key that lets two stats providers be compared.
--
-- `RULES.md` §7 requires two independent providers to agree before a week's
-- scores finalise, and "agree" means joining their rows for the same player.
-- Until now there was no key to join on: `stat_lines` has carried a `source`
-- column since `0003` and `stat_lines_current` keys on it, so the storage has
-- always been ready for a second provider — but nothing recorded who a player
-- *is* at the other one.
--
-- **Not name matching, and that is the point.** "A.J. Brown", "AJ Brown" and
-- "Aj Brown" are one player and three strings; two players share a name most
-- seasons; and a fuzzy join that is 99% right is a join that pays the wrong
-- person once a week. Tank01 publishes Sleeper's id on its own player list
-- (`sleeperBotID`), so the correspondence is asserted by the provider rather
-- than guessed by us. That is the whole reason a second source is affordable
-- here rather than a project of its own.
--
-- **Nullable, and null means uncompared.** 4,222 of Tank01's roughly 4,300
-- players carry the field. A player it omits is simply not cross-checked, which
-- is a smaller failure than being cross-checked against somebody else — and it
-- is visible, because the comparison can report how many players it could not
-- join rather than quietly covering fewer of them each week.
--
-- Named for the role rather than the vendor. If the second source is ever
-- something other than Sleeper, this column holds that provider's id and no
-- migration is needed to say so.
--
-- Additive and nullable. No backfill, no trigger, no change to any existing
-- column: a player nobody has synced since this landed reads NULL, and the
-- comparison treats that exactly as it treats a player Sleeper does not carry.

ALTER TABLE players ADD COLUMN second_source_ref text;

-- Looked up in one direction only — given a Sleeper id from a week of stats,
-- find our player. The reverse (our player to their id) is a column read on a
-- row already in hand and needs no index.
--
-- Partial, because most of the table is not null but a meaningful minority is,
-- and an index over the nulls would be dead weight in the one query that uses it.
CREATE INDEX players_second_source_ref_idx
    ON players (sport_id, second_source_ref)
 WHERE second_source_ref IS NOT NULL;
