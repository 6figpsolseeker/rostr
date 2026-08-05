-- Identity.
--
-- A wallet is an address, not a person. Email gives an identity that exists
-- before someone opens the app, which invites and display names both need.

CREATE TABLE users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email              text NOT NULL,
  email_verified_at  timestamptz,
  display_name       text NOT NULL CHECK (length(btrim(display_name)) > 0),
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- Case-insensitive uniqueness via a functional index rather than citext: no
-- extension to install, works identically on PGlite and Supabase.
CREATE UNIQUE INDEX users_email_lower_idx ON users (lower(email));

CREATE TABLE wallets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  address      text NOT NULL,
  chain        text NOT NULL DEFAULT 'solana',
  verified_at  timestamptz,
  is_primary   boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chain, address)
);

CREATE INDEX wallets_user_idx ON wallets (user_id);

-- At most one primary wallet per user.
CREATE UNIQUE INDEX wallets_one_primary_per_user
  ON wallets (user_id)
  WHERE is_primary;

-- IP addresses are logged as a review signal for detecting collusion, never as a
-- gate on joining. Households, dorms, and offices share addresses, and those are
-- exactly the people who play in leagues together. Kept in its own table so it
-- can be dropped wholesale for a retention policy.
CREATE TABLE auth_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     uuid REFERENCES users (id) ON DELETE SET NULL,
  event       text NOT NULL,
  ip_address  inet,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX auth_events_user_idx ON auth_events (user_id, created_at DESC);
CREATE INDEX auth_events_ip_idx ON auth_events (ip_address, created_at DESC);
