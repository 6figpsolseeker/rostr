-- Email verification tokens.
--
-- Only the SHA-256 of the token is stored. A database leak then does not hand an
-- attacker working verification links, the same reasoning as password hashing.
--
-- One outstanding token per user: issuing a new one supersedes the old, so a
-- link from an earlier request cannot still be used.

CREATE TABLE email_verification_tokens (
  user_id     uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  token_hash  char(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX email_verification_tokens_expiry_idx ON email_verification_tokens (expires_at);
