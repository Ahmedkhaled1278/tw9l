-- Phase 21: persistent profile avatars stored outside the public web root.
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_storage_name text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_mime_type text;
INSERT INTO app_schema_migrations(version,name) VALUES(106,'phase21_profile_avatars') ON CONFLICT(version) DO NOTHING;
