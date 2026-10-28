'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const databaseUrl = process.env.TEST_DATABASE_URL;
test('PostgreSQL createDirect is race-safe under 20 concurrent requests', { skip: !databaseUrl && 'Set TEST_DATABASE_URL to a disposable database with migrations applied.' }, async () => {
  process.env.DATABASE_URL = databaseUrl;
  const { createPgStorage } = require('../server/storage/pg');
  const storage = createPgStorage();
  const suffix = crypto.randomUUID();
  const userA = { id: `usr_${crypto.randomUUID()}`, name: 'Test A', email: `wasl-a-${suffix}@example.invalid`, passwordHash: 'test-hash', createdAt: new Date().toISOString() };
  const userB = { id: `usr_${crypto.randomUUID()}`, name: 'Test B', email: `wasl-b-${suffix}@example.invalid`, passwordHash: 'test-hash', createdAt: new Date().toISOString() };
  try {
    await storage.users.create(userA); await storage.users.create(userB);
    const results = await Promise.all(Array.from({ length: 20 }, () => storage.conversations.createDirect({ userId: userA.id, recipientId: userB.id, title: 'concurrency test', createdAt: new Date().toISOString() })));
    assert.equal(new Set(results.map(x => x.conversation.id)).size, 1);
    assert.equal(results.filter(x => x.created).length, 1);
    assert.equal(results[0].conversation.memberIds.length, 2);
  } finally {
    // Cascade deletes remove this test's direct conversation and memberships.
    const { pool } = require('../server/storage/pg/pool');
    await pool.query('DELETE FROM users WHERE id = ANY($1::text[])', [[userA.id, userB.id]]).catch(() => {});
    await storage.close();
  }
});
