-- Phase 15: message editing, soft deletion, replies, forwarding, pinning and read receipts.
-- Safe to run on existing phase-14 installations; intentionally idempotent.
BEGIN;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited_at timestamptz;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_message_id text REFERENCES messages(id) ON DELETE SET NULL;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS forwarded_from_message_id text REFERENCES messages(id) ON DELETE SET NULL;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS pinned_at timestamptz;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS pinned_by text REFERENCES users(id) ON DELETE SET NULL;
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
INSERT INTO app_schema_migrations(version,name) VALUES(103,'phase15_message_features') ON CONFLICT(version) DO NOTHING;
COMMIT;
