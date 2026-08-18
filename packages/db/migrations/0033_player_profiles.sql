-- Who a player is, for the screens that show one.
--
-- Everything here is display data: a face, a number, a college, an injury
-- designation. **Nothing scores, ranks, locks, or settles from any of it**, and
-- that separation is the point — these columns can be wrong, stale, or null
-- without a single point moving. Keep it that way. If a rule ever needs to read
-- one of these, it stops being a profile column and needs the treatment
-- `stat_lines` gets: a source, a revision, and an audit trail.
--
-- **Why the image is stored rather than derived.** Our provider's player id is
-- also ESPN's athlete id, so `.../headshots/nfl/players/full/<id>.png` looks
-- like it can be composed on the fly with no column at all. Measured against
-- the live player list on 2026-08-18: that URL is wrong for **361 of 4,202
-- players** — 325 rookies are served from the `college-football` path instead,
-- and 36 have no photo and resolve to a placeholder. It would also put a
-- provider's hostname in our own rendering code, which is the one thing the
-- provider interface exists to prevent. The provider publishes the URL; the
-- adapter maps it; nothing downstream learns whose it is.
--
-- Additive and nullable throughout. No backfill, no trigger, no change to any
-- existing column — a player nobody has synced since this landed reads NULL and
-- the screens fall back to initials.

ALTER TABLE players ADD COLUMN image_url      text;

-- Free text, deliberately. Jersey numbers have leading zeros ("00" is legal and
-- worn), so this is an identifier that happens to look numeric.
ALTER TABLE players ADD COLUMN jersey_number  text;

-- The provider's own units, named so nothing has to guess. Integers, because
-- invariant 2 has no exception for a height. A metric renderer converts at
-- display time; storing centimetres would round a 230 lb weight to 104 kg and
-- back to 229 lb, which is a wrong number on a page for no gain.
ALTER TABLE players ADD COLUMN height_inches  smallint;
ALTER TABLE players ADD COLUMN weight_pounds  smallint;

-- The date, never the age. An age column is wrong the day after it is written
-- and nothing would ever notice.
ALTER TABLE players ADD COLUMN birth_date     date;

ALTER TABLE players ADD COLUMN college        text;

-- Where they entered the league. Stable for a career, unlike "years of
-- experience", which the provider ships as a number that silently drifts.
ALTER TABLE players ADD COLUMN draft_year     smallint;
ALTER TABLE players ADD COLUMN draft_round    smallint;
ALTER TABLE players ADD COLUMN draft_pick     smallint;

-- The provider's wording, preserved rather than mapped to an enum of ours.
-- "Questionable", "Out", "Injured Reserve" are the ones seen in the live list;
-- an unfamiliar fourth must render, not fail a cast.
--
-- **This is not a lineup rule and must never become one.** `RULES.md` §6 locks a
-- slot on that player's own kickoff and says nothing about whether he is fit —
-- starting a doubtful player is a manager's call to make, and a designation
-- arriving late must not be able to change a lineup that was already legal.
ALTER TABLE players ADD COLUMN injury_designation text;
ALTER TABLE players ADD COLUMN injury_description text;
ALTER TABLE players ADD COLUMN injury_return_date date;
