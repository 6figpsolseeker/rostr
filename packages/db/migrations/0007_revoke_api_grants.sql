-- Revoke Data API privileges from the PostgREST roles.
--
-- ## Why this exists
--
-- Supabase configures ALTER DEFAULT PRIVILEGES at project creation so that every
-- new table in `public` is granted to `anon` and `authenticated`. That happens
-- as tables are created, independently of the dashboard's "auto-expose new
-- tables" toggle — so our migrations produced tables with:
--
--   anon -> DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE
--
-- on all of them, including `league_rules`, `league_memberships`, and `users`.
-- Verified against the real database, not assumed.
--
-- Nothing was exposed: the Data API is disabled, and RLS is enabled with no
-- policies. But that leaves the whole guarantee resting on RLS never being
-- switched off on any table — and switching RLS off on one table while
-- debugging is an ordinary thing to do. TRUNCATE on `league_rules` would
-- destroy the immutability the entire project is built around.
--
-- We never use the Data API. These roles should hold nothing.
--
-- ## Portability
--
-- The roles do not exist on PGlite, where the test suite runs. Each statement is
-- therefore guarded — the migration is a no-op anywhere the roles are absent.

DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN

      -- Existing objects.
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', api_role);

      -- Future objects. Without this, the next migration re-grants everything.
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I',
        api_role
      );
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I',
        api_role
      );
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I',
        api_role
      );

      -- Default privileges are recorded per granting role. Ours are created by
      -- `postgres`, so revoke under that role explicitly as well — otherwise the
      -- grant returns for anything created in a different session context.
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN
        EXECUTE format(
          'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM %I',
          api_role
        );
        EXECUTE format(
          'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I',
          api_role
        );
        EXECUTE format(
          'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I',
          api_role
        );
      END IF;

      -- Without USAGE on the schema, a stray future grant is unreachable anyway.
      EXECUTE format('REVOKE USAGE ON SCHEMA public FROM %I', api_role);

    END IF;
  END LOOP;
END
$$;
