-- Create non-superuser app role for RLS enforcement.
-- Superusers bypass RLS even with FORCE, so the app must connect as this role.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'flakey_app') THEN
    CREATE ROLE flakey_app LOGIN PASSWORD 'flakey_app';
  END IF;
END
$$;

GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO flakey_app;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO flakey_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO flakey_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO flakey_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO flakey_app;
