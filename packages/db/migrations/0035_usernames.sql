-- A name other people can type.
--
-- Until now a user was reachable only by email address, which is fine for
-- signing in and useless for everything else: a commissioner inviting eleven
-- friends had to know eleven email addresses, and an email address is the one
-- identifier people are careful about handing out. A username is the thing you
-- say out loud in a group chat.
--
-- **Nullable, deliberately.** Every existing account predates this column, and
-- signing in must not become a form somebody has to fill in first. It is claimed
-- at the point it is needed — when a wallet is connected, which is also the
-- moment a stranger becomes somebody who can be invited to a league.
--
-- **Case-insensitive uniqueness, case-preserving storage.** `dakPrescott` and
-- `dakprescott` must not be two people — the whole point is that a commissioner
-- can type what they were told — but the capitals somebody chose are theirs to
-- keep. Same functional-index trick `users_email_lower_idx` already uses: no
-- extension to install, and it behaves identically on PGlite and Supabase.
--
-- NULLs are not equal to each other in Postgres, so every account without one
-- coexists happily under this index.
ALTER TABLE users ADD COLUMN username text;

CREATE UNIQUE INDEX users_username_lower_idx ON users (lower(username));

-- A floor, not the rule.
--
-- The real validation lives in `validateUsername` and is stricter — it also
-- refuses reserved words and names that are only digits. This constraint exists
-- so that a future caller writing straight SQL, or a migration, cannot leave a
-- row the application would refuse to have created: length, character set, and
-- a leading letter. A username appears in URLs and in invitations, so "what
-- characters are legal" is not a preference that should live in one code path.
ALTER TABLE users ADD CONSTRAINT users_username_shape
  CHECK (username IS NULL OR username ~ '^[A-Za-z][A-Za-z0-9_]{2,19}$');
