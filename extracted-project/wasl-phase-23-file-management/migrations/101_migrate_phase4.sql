-- Phase-4 -> normalized schema migration.
-- Prerequisites: restore a backup to staging; run 100_preflight.sql; apply
-- server/storage/pg/schema.sql to create the normalized target tables.
-- This migration deliberately aborts on ambiguous/invalid records. Source
-- wasl_* tables are never deleted or modified. Run once on a staging clone first.
BEGIN;
DO $$
DECLARE missing_tables integer;
BEGIN
  SELECT COUNT(*) INTO missing_tables FROM (VALUES
    ('wasl_users'), ('wasl_conversations'), ('wasl_messages'), ('wasl_attachments'),
    ('users'), ('conversations'), ('conversation_members'), ('messages'), ('attachments')
  ) AS expected(name)
  WHERE to_regclass(expected.name) IS NULL;
  IF missing_tables > 0 THEN RAISE EXCEPTION 'Required source/target tables are missing. Run preflight and schema setup first.'; END IF;
  IF NOT EXISTS (SELECT 1 FROM app_schema_migrations WHERE version = 5) AND (
    EXISTS (SELECT 1 FROM users) OR EXISTS (SELECT 1 FROM conversations) OR
    EXISTS (SELECT 1 FROM conversation_members) OR EXISTS (SELECT 1 FROM messages) OR EXISTS (SELECT 1 FROM attachments)
  ) THEN
    RAISE EXCEPTION 'Target normalized tables are not empty and migration version 5 is not recorded; use a clean staging database.';
  END IF;
  IF EXISTS (SELECT 1 FROM wasl_users WHERE NOT (payload ? 'email' AND payload ? 'passwordHash')) THEN
    RAISE EXCEPTION 'Some source users are missing email or passwordHash; inspect 100_preflight.sql.';
  END IF;
  IF EXISTS (SELECT 1 FROM wasl_conversations WHERE COALESCE(jsonb_typeof(payload->'memberIds'), 'missing') <> 'array' OR jsonb_array_length(payload->'memberIds') < 2) THEN
    RAISE EXCEPTION 'Each legacy conversation must have a memberIds array containing at least two members.';
  END IF;
  IF EXISTS (SELECT 1 FROM wasl_conversations c CROSS JOIN LATERAL jsonb_array_elements_text(c.payload->'memberIds') m(user_id) GROUP BY c.id HAVING COUNT(*) <> COUNT(DISTINCT m.user_id)) THEN
    RAISE EXCEPTION 'A legacy conversation contains duplicate memberIds.';
  END IF;
  IF EXISTS (SELECT 1 FROM wasl_users GROUP BY lower(payload->>'email') HAVING COUNT(*) > 1) THEN
    RAISE EXCEPTION 'Duplicate case-insensitive emails exist; resolve before migration.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM wasl_conversations c
    CROSS JOIN LATERAL (SELECT min(v) AS low_id, max(v) AS high_id FROM jsonb_array_elements_text(c.payload->'memberIds') x(v)) pair
    WHERE jsonb_array_length(c.payload->'memberIds') = 2
    GROUP BY pair.low_id, pair.high_id HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate legacy direct conversations exist for the same member pair; resolve them before migration.';
  END IF;
  IF EXISTS (SELECT 1 FROM wasl_attachments GROUP BY payload->>'storageName' HAVING COUNT(*) > 1) THEN
    RAISE EXCEPTION 'Duplicate attachment storageName values exist; resolve them before migration.';
  END IF;
  IF EXISTS (SELECT 1 FROM wasl_attachments WHERE id !~ '^att_[0-9a-fA-F-]{36}$') THEN
    RAISE EXCEPTION 'Unexpected legacy attachment ID format; inspect preflight output.';
  END IF;
  IF EXISTS (SELECT 1 FROM wasl_attachments a LEFT JOIN wasl_conversations c ON c.id=a.payload->>'conversationId' LEFT JOIN wasl_users u ON u.id=a.payload->>'uploadedBy' WHERE c.id IS NULL OR u.id IS NULL OR NULLIF(a.payload->>'storageName','') IS NULL) THEN
    RAISE EXCEPTION 'An attachment has missing conversation/uploader/storageName; migration stopped.';
  END IF;
  IF EXISTS (SELECT 1 FROM wasl_messages WHERE COALESCE(payload->>'deletedAt','') = '' AND COALESCE(payload->>'text',payload->>'body') IS NULL) THEN
    RAISE EXCEPTION 'A message is missing text/body; migration stopped.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM wasl_conversations c
    CROSS JOIN LATERAL jsonb_array_elements_text(c.payload->'memberIds') AS member(user_id)
    LEFT JOIN wasl_users u ON u.id = member.user_id
    WHERE u.id IS NULL
  ) THEN RAISE EXCEPTION 'A conversation references a missing user.'; END IF;
  IF EXISTS (
    SELECT 1 FROM wasl_messages m LEFT JOIN wasl_conversations c ON c.id = m.payload->>'conversationId'
    LEFT JOIN wasl_users u ON u.id = m.payload->>'senderId'
    WHERE c.id IS NULL OR u.id IS NULL
  ) THEN RAISE EXCEPTION 'A message references a missing conversation or sender.'; END IF;
END $$;

INSERT INTO users (id,email,password_hash,display_name,created_at,updated_at)
SELECT id, lower(payload->>'email'), payload->>'passwordHash',
       COALESCE(NULLIF(payload->>'name',''), NULLIF(payload->>'displayName',''), 'Wasl user'),
       COALESCE(NULLIF(payload->>'createdAt','')::timestamptz, now()),
       COALESCE(NULLIF(payload->>'updatedAt','')::timestamptz, NULLIF(payload->>'createdAt','')::timestamptz, now())
FROM wasl_users ON CONFLICT (id) DO NOTHING;

-- Two-member conversations become direct chats; conversations with more members become groups. IDs are preserved.
INSERT INTO conversations (id,type,title,dm_user_low,dm_user_high,created_at,updated_at)
SELECT c.id,
       CASE WHEN jsonb_array_length(c.payload->'memberIds') = 2 THEN 'direct' ELSE 'group' END,
       COALESCE(NULLIF(c.payload->>'title',''), CASE WHEN jsonb_array_length(c.payload->'memberIds') = 2 THEN NULL ELSE 'مجموعة' END),
       CASE WHEN jsonb_array_length(c.payload->'memberIds') = 2 THEN m.user_low ELSE NULL END,
       CASE WHEN jsonb_array_length(c.payload->'memberIds') = 2 THEN m.user_high ELSE NULL END,
       COALESCE(NULLIF(c.payload->>'createdAt','')::timestamptz, now()),
       COALESCE(NULLIF(c.payload->>'updatedAt','')::timestamptz, NULLIF(c.payload->>'createdAt','')::timestamptz, now())
FROM wasl_conversations c
CROSS JOIN LATERAL (
  SELECT min(v) AS user_low, max(v) AS user_high
  FROM jsonb_array_elements_text(c.payload->'memberIds') x(v)
) m
ON CONFLICT (id) DO NOTHING;

INSERT INTO conversation_members (conversation_id,user_id,role,joined_at)
SELECT c.id, member.user_id, CASE WHEN c.payload->>'ownerId' = member.user_id THEN 'owner' ELSE 'member' END, COALESCE(NULLIF(c.payload->>'createdAt','')::timestamptz, now())
FROM wasl_conversations c CROSS JOIN LATERAL jsonb_array_elements_text(c.payload->'memberIds') member(user_id)
ON CONFLICT (conversation_id,user_id) DO NOTHING;

INSERT INTO messages (id,conversation_id,sender_id,body,created_at,deleted_at)
SELECT m.id, m.payload->>'conversationId', m.payload->>'senderId',
       CASE WHEN NULLIF(m.payload->>'deletedAt','') IS NOT NULL THEN NULL ELSE COALESCE(m.payload->>'text', m.payload->>'body') END,
       COALESCE(NULLIF(m.payload->>'createdAt','')::timestamptz, now()),
       NULLIF(m.payload->>'deletedAt','')::timestamptz
FROM wasl_messages m
WHERE EXISTS (SELECT 1 FROM conversations c WHERE c.id=m.payload->>'conversationId')
  AND EXISTS (SELECT 1 FROM users u WHERE u.id=m.payload->>'senderId')
ON CONFLICT (id) DO NOTHING;

-- Link each attachment to the legacy message whose attachment.id matches, when present.
INSERT INTO attachments (id,conversation_id,uploader_id,message_id,status,filename,detected_mime,size_bytes,storage_path,sha256,created_at)
SELECT a.id, a.payload->>'conversationId', a.payload->>'uploadedBy', linked.message_id,
       CASE WHEN linked.message_id IS NULL THEN 'orphaned' ELSE 'attached' END,
       COALESCE(NULLIF(a.payload->>'originalName',''), 'attachment'),
       COALESCE(NULLIF(a.payload->>'mimeType',''), 'application/octet-stream'),
       GREATEST(COALESCE(NULLIF(a.payload->>'size','')::bigint,0),0),
       a.payload->>'storageName', NULL,
       COALESCE(NULLIF(a.payload->>'createdAt','')::timestamptz,now())
FROM wasl_attachments a
LEFT JOIN LATERAL (
  SELECT m.id AS message_id FROM wasl_messages m
  WHERE m.payload->'attachment'->>'id' = a.id
  ORDER BY m.created_at LIMIT 1
) linked ON true
WHERE EXISTS (SELECT 1 FROM conversations c WHERE c.id=a.payload->>'conversationId')
  AND EXISTS (SELECT 1 FROM users u WHERE u.id=a.payload->>'uploadedBy')
  AND NULLIF(a.payload->>'storageName','') IS NOT NULL
ON CONFLICT (id) DO NOTHING;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM wasl_users s LEFT JOIN users t ON t.id=s.id WHERE t.id IS NULL) THEN
    RAISE EXCEPTION 'Post-migration verification failed: one or more users are missing.';
  END IF;
  IF EXISTS (SELECT 1 FROM wasl_conversations s LEFT JOIN conversations t ON t.id=s.id WHERE t.id IS NULL) THEN
    RAISE EXCEPTION 'Post-migration verification failed: one or more conversations are missing.';
  END IF;
  IF EXISTS (SELECT 1 FROM wasl_messages s LEFT JOIN messages t ON t.id=s.id WHERE t.id IS NULL) THEN
    RAISE EXCEPTION 'Post-migration verification failed: one or more messages are missing.';
  END IF;
  IF EXISTS (SELECT 1 FROM wasl_attachments s LEFT JOIN attachments t ON t.id=s.id WHERE t.id IS NULL) THEN
    RAISE EXCEPTION 'Post-migration verification failed: one or more attachments are missing.';
  END IF;
  IF (SELECT COUNT(*) FROM users) <> (SELECT COUNT(*) FROM wasl_users)
     OR (SELECT COUNT(*) FROM conversations) <> (SELECT COUNT(*) FROM wasl_conversations)
     OR (SELECT COUNT(*) FROM messages) <> (SELECT COUNT(*) FROM wasl_messages)
     OR (SELECT COUNT(*) FROM attachments) <> (SELECT COUNT(*) FROM wasl_attachments) THEN
    RAISE EXCEPTION 'Post-migration verification failed: source and target row counts differ.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM wasl_conversations c, LATERAL jsonb_array_elements_text(c.payload->'memberIds') m(user_id)
    LEFT JOIN conversation_members cm ON cm.conversation_id=c.id AND cm.user_id=m.user_id
    WHERE cm.user_id IS NULL
  ) THEN RAISE EXCEPTION 'Post-migration verification failed: one or more memberships are missing.'; END IF;
END $$;

INSERT INTO app_schema_migrations(version,name) VALUES (5,'normalized-storage-phase5') ON CONFLICT (version) DO NOTHING;
COMMIT;
