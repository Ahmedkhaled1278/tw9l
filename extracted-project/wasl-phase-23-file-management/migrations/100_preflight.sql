-- READ ONLY preflight for a phase-4 database. This script makes no changes.
-- Run against a restored staging copy first. It expects the four wasl_* tables.
SELECT 'wasl_users' AS table_name, COUNT(*) AS rows FROM wasl_users
UNION ALL SELECT 'wasl_conversations', COUNT(*) FROM wasl_conversations
UNION ALL SELECT 'wasl_messages', COUNT(*) FROM wasl_messages
UNION ALL SELECT 'wasl_attachments', COUNT(*) FROM wasl_attachments
ORDER BY 1;

SELECT 'users' AS source, k.key, COUNT(*) AS rows_with_key
FROM wasl_users u CROSS JOIN LATERAL jsonb_object_keys(u.payload) AS k(key)
GROUP BY k.key ORDER BY rows_with_key DESC, k.key;
SELECT 'conversations' AS source, k.key, COUNT(*) AS rows_with_key
FROM wasl_conversations c CROSS JOIN LATERAL jsonb_object_keys(c.payload) AS k(key)
GROUP BY k.key ORDER BY rows_with_key DESC, k.key;
SELECT 'messages' AS source, k.key, COUNT(*) AS rows_with_key
FROM wasl_messages m CROSS JOIN LATERAL jsonb_object_keys(m.payload) AS k(key)
GROUP BY k.key ORDER BY rows_with_key DESC, k.key;
SELECT 'attachments' AS source, k.key, COUNT(*) AS rows_with_key
FROM wasl_attachments a CROSS JOIN LATERAL jsonb_object_keys(a.payload) AS k(key)
GROUP BY k.key ORDER BY rows_with_key DESC, k.key;

SELECT 'users' AS source, COUNT(*) FILTER (WHERE id !~ '^usr_[0-9a-fA-F-]{36}$') AS bad_ids FROM wasl_users
UNION ALL SELECT 'conversations', COUNT(*) FILTER (WHERE id !~ '^cnv_[0-9a-fA-F-]{36}$') FROM wasl_conversations
UNION ALL SELECT 'messages', COUNT(*) FILTER (WHERE id !~ '^msg_[0-9a-fA-F-]{36}$') FROM wasl_messages
UNION ALL SELECT 'attachments', COUNT(*) FILTER (WHERE id !~ '^att_[0-9a-fA-F-]{36}$') FROM wasl_attachments;

SELECT COUNT(*) AS duplicate_email_groups
FROM (SELECT lower(payload->>'email') AS normalized_email FROM wasl_users
      WHERE payload ? 'email' GROUP BY lower(payload->>'email') HAVING COUNT(*) > 1) duplicates;

SELECT COUNT(*) FILTER (WHERE payload ? 'memberIds') AS has_member_ids,
       COUNT(*) FILTER (WHERE payload ? 'members') AS has_members,
       COUNT(*) FILTER (WHERE payload ? 'ownerId') AS has_owner,
       COUNT(*) FILTER (WHERE jsonb_typeof(payload->'memberIds') = 'array') AS member_ids_is_array
FROM wasl_conversations;

-- Redacted samples: avoid printing emails, member IDs, message text, or disk paths.
-- This script is read-only; use the key-frequency results above to inspect field names.
SELECT id, jsonb_set(payload - 'passwordHash' - 'password', '{email}', '"[redacted]"'::jsonb, false) AS payload
FROM wasl_users LIMIT 3;
SELECT id, payload - 'memberIds' - 'members' - 'title' AS payload FROM wasl_conversations LIMIT 3;
SELECT id, payload - 'text' - 'body' - 'attachment' AS payload FROM wasl_messages LIMIT 3;
SELECT id, payload - 'storageName' - 'originalName' - 'filename' AS payload FROM wasl_attachments LIMIT 3;
