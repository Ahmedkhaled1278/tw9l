-- Read-only verification after migration. Run on staging before any cutover.
\set ON_ERROR_STOP on
SELECT 'users' AS entity, (SELECT COUNT(*) FROM wasl_users) AS source_count, (SELECT COUNT(*) FROM users) AS target_count
UNION ALL SELECT 'conversations', (SELECT COUNT(*) FROM wasl_conversations), (SELECT COUNT(*) FROM conversations)
UNION ALL SELECT 'messages', (SELECT COUNT(*) FROM wasl_messages), (SELECT COUNT(*) FROM messages)
UNION ALL SELECT 'attachments', (SELECT COUNT(*) FROM wasl_attachments), (SELECT COUNT(*) FROM attachments)
ORDER BY entity;

SELECT 'messages_without_conversation' AS check_name, COUNT(*) AS failures
FROM messages m LEFT JOIN conversations c ON c.id=m.conversation_id WHERE c.id IS NULL
UNION ALL SELECT 'messages_without_sender', COUNT(*) FROM messages m LEFT JOIN users u ON u.id=m.sender_id WHERE u.id IS NULL
UNION ALL SELECT 'attachments_without_conversation', COUNT(*) FROM attachments a LEFT JOIN conversations c ON c.id=a.conversation_id WHERE c.id IS NULL
UNION ALL SELECT 'attachments_without_uploader', COUNT(*) FROM attachments a LEFT JOIN users u ON u.id=a.uploader_id WHERE u.id IS NULL
UNION ALL SELECT 'members_without_user', COUNT(*) FROM conversation_members cm LEFT JOIN users u ON u.id=cm.user_id WHERE u.id IS NULL
UNION ALL SELECT 'direct_without_pair', COUNT(*) FROM conversations WHERE type='direct' AND (dm_user_low IS NULL OR dm_user_high IS NULL OR dm_user_low >= dm_user_high)
UNION ALL SELECT 'attached_without_message', COUNT(*) FROM attachments WHERE status='attached' AND message_id IS NULL
UNION ALL SELECT 'attached_message_mismatch', COUNT(*) FROM attachments a JOIN messages m ON m.id=a.message_id WHERE a.conversation_id <> m.conversation_id;
