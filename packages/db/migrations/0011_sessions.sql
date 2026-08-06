-- Sessions, and proof that a wallet belongs to the person holding it.

-- Only the SHA-256 of the session token is stored, never the token. Same
-- reasoning as password hashing: a database leak must not hand an attacker
-- working logins. The token itself exists only in the user's cookie.
CREATE TABLE sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash  char(64) NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz
);

CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_expiry_idx ON sessions (expires_at) WHERE revoked_at IS NULL;

-- A nonce a wallet must sign to prove the person signing in actually holds its
-- private key.
--
-- Without this, "linking a wallet" is just typing an address, and anyone could
-- claim any address — including one that already holds a league stake. The
-- challenge is single-use and short-lived so a signature captured once cannot be
-- replayed later.
CREATE TABLE wallet_challenges (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  address     text NOT NULL,
  nonce       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  -- One live challenge per user and address. Issuing a new one supersedes the
  -- old, so a stale nonce cannot sit around waiting to be replayed.
  UNIQUE (user_id, address)
);

CREATE INDEX wallet_challenges_expiry_idx ON wallet_challenges (expires_at);
