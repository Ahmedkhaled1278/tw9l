-- Phase 17: durable notifications, account privacy preferences, revocable sessions.
ALTER TABLE users ADD COLUMN IF NOT EXISTS privacy_settings jsonb NOT NULL DEFAULT '{"showLastSeen":"everyone","showOnlineStatus":"everyone","notificationsEnabled":true}'::jsonb;
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
INSERT INTO app_schema_migrations(version,name) VALUES(105,'phase17_notifications_privacy_sessions') ON CONFLICT(version) DO NOTHING;
