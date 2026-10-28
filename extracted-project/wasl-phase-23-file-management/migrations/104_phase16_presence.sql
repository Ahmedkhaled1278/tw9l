-- Phase 16: persistent last-seen timestamp; online state remains socket-derived.
-- Safe and idempotent for phase-15 PostgreSQL deployments.
BEGIN;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;
INSERT INTO app_schema_migrations(version,name) VALUES(104,'phase16_presence') ON CONFLICT(version) DO NOTHING;
COMMIT;
