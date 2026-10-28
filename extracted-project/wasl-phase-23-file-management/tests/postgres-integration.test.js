'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const databaseUrl = process.env.TEST_DATABASE_URL;
test('PostgreSQL repositories enforce message, notification, session and privacy rules with bounded pagination', {
  skip: !databaseUrl && 'Set TEST_DATABASE_URL to a disposable PostgreSQL database after applying migrations/001_init.sql.'
}, async () => {
  process.env.DATABASE_URL = databaseUrl;
  const { createPgStorage } = require('../server/storage/pg');
  const { pool } = require('../server/storage/pg/pool');
  const storage = createPgStorage();
  const suffix = crypto.randomUUID();
  const now = new Date().toISOString();
  const alice = { id: `usr_${suffix}_a`, name: 'PG Alice', email: `pg-a-${suffix}@example.invalid`, passwordHash: 'test-hash', createdAt: now };
  const bob = { id: `usr_${suffix}_b`, name: 'PG Bob', email: `pg-b-${suffix}@example.invalid`, passwordHash: 'test-hash', createdAt: now };
  let conversationId;
  try {
    await storage.init();
    await storage.users.create(alice);
    await storage.users.create(bob);
    const direct = await storage.conversations.createDirect({ userId: alice.id, recipientId: bob.id, title: 'PostgreSQL integration', createdAt: now });
    conversationId = direct.conversation.id;
    assert.equal(direct.created, true);
    assert.equal(await storage.conversations.isMember(conversationId, alice.id), true);
    assert.equal(await storage.conversations.isMember(conversationId, 'usr_not_a_member'), false);

    const message = { id: `msg_${suffix}`, conversationId, senderId: alice.id, text: 'original', createdAt: now, replyToMessageId: null, forwardedFromMessageId: null };
    const created = await storage.messages.create(message);
    assert.equal(created.text, 'original');
    const edited = await storage.messages.edit({ messageId: message.id, conversationId, actorId: alice.id, text: 'edited', editedAt: new Date(Date.now() + 1000).toISOString() });
    assert.equal(edited.text, 'edited');
    await assert.rejects(
      storage.messages.edit({ messageId: message.id, conversationId, actorId: bob.id, text: 'unauthorized', editedAt: now }),
      err => err.code === 'MESSAGE_FORBIDDEN'
    );
    const readIds = await storage.messages.markRead({ conversationId, userId: bob.id, messageId: message.id, readAt: new Date().toISOString() });
    assert.ok(readIds.includes(message.id));
    assert.ok((await storage.messages.getById(message.id)).readBy.includes(bob.id));

    const notificationRows = await storage.notifications.createForUsers({ users: [alice.id, bob.id], conversationId, messageId: message.id, senderId: alice.id, preview: 'edited', createdAt: now });
    assert.deepEqual(notificationRows.map(row => row.userId), [bob.id]);
    assert.equal(await storage.notifications.unreadCount(bob.id), 1);
    assert.equal(await storage.notifications.markRead({ userId: alice.id, notificationId: notificationRows[0].id, readAt: now }), null);
    assert.equal((await storage.notifications.markRead({ userId: bob.id, notificationId: notificationRows[0].id, readAt: now })).userId, bob.id);

    await storage.users.setPrivacy(bob.id, { notificationsEnabled: false, showLastSeen: 'nobody' });
    assert.equal((await storage.users.getPrivacy(bob.id)).showLastSeen, 'nobody');
    const suppressed = await storage.notifications.createForUsers({ users: [alice.id, bob.id], conversationId, messageId: message.id, senderId: alice.id, preview: 'suppressed', createdAt: now });
    assert.equal(suppressed.length, 0);

    const session = { id: `ses_${suffix}`, userId: alice.id, createdAt: now, expiresAt: new Date(Date.now() + 3600_000).toISOString(), userAgent: 'test', ip: '127.0.0.1' };
    await storage.sessions.create(session);
    assert.equal(await storage.sessions.revoke({ sessionId: session.id, userId: bob.id, revokedAt: now }), false);
    assert.equal(await storage.sessions.revoke({ sessionId: session.id, userId: alice.id, revokedAt: now }), true);
    assert.ok((await storage.sessions.getById(session.id)).revokedAt);

    // Populate a moderate-sized history using one parameterized SQL statement, then
    // exercise the production repository's indexed, bounded page query.
    await pool.query(`INSERT INTO messages(id,conversation_id,sender_id,body,created_at)
      SELECT 'msg_perf_' || $1 || '_' || n, $2, $3, 'load-' || n, $4::timestamptz + (n * interval '1 millisecond')
      FROM generate_series(1, 500) AS n`, [suffix, conversationId, alice.id, now]);
    const started = performance.now();
    const page = await storage.messages.listForConversation(conversationId, { limit: 50 });
    const elapsedMs = performance.now() - started;
    assert.equal(page.length, 50);
    assert.ok(elapsedMs < 3000, `50-message page query took ${Math.round(elapsedMs)}ms for a 501-message conversation`);
    assert.ok(page.every(item => item.conversationId === conversationId));
    console.log(`# PostgreSQL 50-message page from 501 messages: ${Math.round(elapsedMs)}ms`);

    const deleted = await storage.messages.remove({ messageId: message.id, conversationId, actorId: alice.id, deletedAt: new Date(Date.now() + 2000).toISOString() });
    assert.equal(deleted.deleted, true);
    assert.equal(deleted.text, '');
    await assert.rejects(
      storage.messages.edit({ messageId: message.id, conversationId, actorId: alice.id, text: 'restore attempt', editedAt: now }),
      err => err.code === 'MESSAGE_NOT_FOUND'
    );
  } finally {
    await pool.query('DELETE FROM users WHERE id = ANY($1::text[])', [[alice.id, bob.id]]).catch(() => {});
    await storage.close();
  }
});
