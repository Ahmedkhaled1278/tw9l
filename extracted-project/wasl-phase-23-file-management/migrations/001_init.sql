-- Fresh-install schema. Existing phase-4 installations must run the explicit
-- preflight and phase-4 migration path; do not run this blindly over live data.
CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  email text NOT NULL,
  password_hash text NOT NULL,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  privacy_settings jsonb NOT NULL DEFAULT '{"showLastSeen":"everyone","showOnlineStatus":"everyone","notificationsEnabled":true}'::jsonb,
  avatar_storage_name text,
  avatar_mime_type text
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_uq ON users (lower(email));
CREATE TABLE IF NOT EXISTS conversations (
  id text PRIMARY KEY,
  type text NOT NULL CHECK (type IN ('direct','group')),
  title text,
  dm_user_low text REFERENCES users(id) ON DELETE CASCADE,
  dm_user_high text REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((type = 'direct' AND dm_user_low IS NOT NULL AND dm_user_high IS NOT NULL AND dm_user_low < dm_user_high)
      OR (type = 'group' AND dm_user_low IS NULL AND dm_user_high IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS conversations_direct_pair_uq
  ON conversations (dm_user_low, dm_user_high) WHERE type = 'direct';
CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX IF NOT EXISTS conversation_members_user_idx ON conversation_members(user_id, conversation_id);
CREATE TABLE IF NOT EXISTS messages (
  id text PRIMARY KEY,
  conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  body text,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  edited_at timestamptz,
  reply_to_message_id text REFERENCES messages(id) ON DELETE SET NULL,
  forwarded_from_message_id text REFERENCES messages(id) ON DELETE SET NULL,
  pinned_at timestamptz,
  pinned_by text REFERENCES users(id) ON DELETE SET NULL,
  CHECK (deleted_at IS NOT NULL OR body IS NOT NULL OR body = '')
);
CREATE INDEX IF NOT EXISTS messages_conversation_created_idx ON messages(conversation_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS messages_reply_idx ON messages(reply_to_message_id) WHERE reply_to_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS messages_forward_idx ON messages(forwarded_from_message_id) WHERE forwarded_from_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS messages_pinned_idx ON messages(conversation_id, pinned_at DESC) WHERE pinned_at IS NOT NULL;
CREATE TABLE IF NOT EXISTS message_receipts (
  message_id text NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id)
);
CREATE INDEX IF NOT EXISTS message_receipts_user_idx ON message_receipts(user_id, message_id);
CREATE TABLE IF NOT EXISTS attachments (
  id text PRIMARY KEY,
  conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  uploader_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  message_id text REFERENCES messages(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('staged','attached','orphaned')),
  filename text NOT NULL,
  detected_mime text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  storage_path text NOT NULL UNIQUE,
  sha256 text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'attached' AND message_id IS NOT NULL) OR (status IN ('staged','orphaned') AND message_id IS NULL))
);
CREATE INDEX IF NOT EXISTS attachments_conversation_idx ON attachments(conversation_id);
CREATE TABLE IF NOT EXISTS app_schema_migrations (
  version integer PRIMARY KEY,
  name text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO app_schema_migrations(version,name) VALUES(103,'phase15_message_features') ON CONFLICT(version) DO NOTHING;

CREATE TABLE IF NOT EXISTS user_sessions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  user_agent text,
  ip text,
  last_used_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS user_sessions_user_active_idx ON user_sessions(user_id, created_at DESC) WHERE revoked_at IS NULL;
CREATE TABLE IF NOT EXISTS notifications (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id text NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  sender_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  preview text NOT NULL CHECK (char_length(preview) <= 120),
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz
);
CREATE INDEX IF NOT EXISTS notifications_user_created_idx ON notifications(user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS notifications_user_unread_idx ON notifications(user_id) WHERE read_at IS NULL;

INSERT INTO app_schema_migrations(version,name) VALUES(104,'phase16_presence') ON CONFLICT(version) DO NOTHING;
INSERT INTO app_schema_migrations(version,name) VALUES(105,'phase17_notifications_privacy_sessions') ON CONFLICT(version) DO NOTHING;
INSERT INTO app_schema_migrations(version,name) VALUES(106,'phase21_profile_avatars') ON CONFLICT(version) DO NOTHING;
