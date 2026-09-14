-- Sign-in moves to Privy, and the account stays ours.
--
-- Privy runs the login ceremony — the emailed code, and a Solana wallet it
-- generates for every account — and rostr keeps its own users, its own
-- sessions and its own `rostr_session` cookie. What joins the two is this
-- column: the Privy user id, read off a token our server verified, never out of
-- a request body.
--
-- **Nullable**, because every account created before this migration has none.
-- An existing account is attached the first time its owner signs in through
-- Privy with the same email — and only when Privy verified that email, which is
-- enforced in `signInWithPrivy` rather than here, because it is a fact about the
-- login and not about the row.
--
-- **Unique**, because one Privy account reaching two rostr accounts would be a
-- second way into somebody else's leagues. NULLs are distinct, so every
-- pre-Privy account coexists under the index.
--
-- No shape check beyond non-empty. The id's format belongs to Privy, and a
-- pattern guessed here would refuse every sign-in the day it changed.
ALTER TABLE users ADD COLUMN privy_user_id text;

CREATE UNIQUE INDEX users_privy_user_id_idx ON users (privy_user_id);

ALTER TABLE users ADD CONSTRAINT users_privy_user_id_not_blank
  CHECK (privy_user_id IS NULL OR length(btrim(privy_user_id)) > 0);

-- An X account, linked after sign-up and never required.
--
-- `x_subject` is X's own stable account id; `x_username` is the handle, which
-- its owner can change on X at any time. So the subject is what is unique and
-- the handle is display data, refreshed on every sign-in. Both are copied from
-- the Privy user record, so linking or unlinking X happens in Privy's flow and
-- reaches this row the next time the account syncs.
--
-- Nothing reads either column to decide anything. They exist for the public
-- side of the product, which is not built yet.
ALTER TABLE users ADD COLUMN x_subject text;
ALTER TABLE users ADD COLUMN x_username text;

CREATE UNIQUE INDEX users_x_subject_idx ON users (x_subject);

-- A handle with no account behind it is a name anybody could have typed.
ALTER TABLE users ADD CONSTRAINT users_x_handle_needs_subject
  CHECK (x_username IS NULL OR x_subject IS NOT NULL);
