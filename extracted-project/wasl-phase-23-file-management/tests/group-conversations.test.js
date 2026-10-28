'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createJsonStorage } = require('../server/storage/json');

test('JSON storage creates group conversations with owner role and preserves separate direct chats', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wasl-groups-'));
  const storage = createJsonStorage(path.join(dir, 'store.json'));
  await storage.init();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const timestamp = new Date().toISOString();
  const users = [
    { id: 'usr_owner', name: 'Owner', email: 'owner@example.invalid', passwordHash: 'hash', createdAt: timestamp },
    { id: 'usr_member', name: 'Member', email: 'member@example.invalid', passwordHash: 'hash', createdAt: timestamp },
    { id: 'usr_third', name: 'Third', email: 'third@example.invalid', passwordHash: 'hash', createdAt: timestamp }
  ];
  for (const user of users) await storage.users.create(user);

  const group = await storage.conversations.createGroup({ title: 'Project team', userId: users[0].id, memberIds: [users[1].id, users[1].id, users[2].id], createdAt: timestamp });
  assert.equal(group.created, true);
  assert.equal(group.conversation.type, 'group');
  assert.equal(group.conversation.memberIds.length, 3);
  assert.equal(group.conversation.memberRoles[users[0].id], 'owner');
  assert.equal(group.conversation.memberRoles[users[1].id], 'member');
  assert.equal(await storage.conversations.isMember(group.conversation.id, users[2].id), true);
  assert.equal(await storage.conversations.isMember(group.conversation.id, 'usr_stranger'), false);

  const direct = await storage.conversations.createDirect({ title: 'Direct', userId: users[0].id, recipientId: users[1].id, createdAt: timestamp });
  assert.equal(direct.conversation.type, 'direct');
  assert.notEqual(direct.conversation.id, group.conversation.id);
  const listed = await storage.conversations.listForUser(users[0].id);
  assert.equal(listed.length, 2);
});


test('group management enforces roles, protects owner and keeps membership consistent', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wasl-group-admin-'));
  const storage = createJsonStorage(path.join(dir, 'store.json'));
  await storage.init();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const timestamp = new Date().toISOString();
  const users = [
    { id: 'usr_owner', name: 'Owner', email: 'owner@example.invalid', passwordHash: 'hash', createdAt: timestamp },
    { id: 'usr_member', name: 'Member', email: 'member@example.invalid', passwordHash: 'hash', createdAt: timestamp },
    { id: 'usr_new', name: 'New', email: 'new@example.invalid', passwordHash: 'hash', createdAt: timestamp }
  ];
  for (const user of users) await storage.users.create(user);
  const created = await storage.conversations.createGroup({ title: 'Initial group', userId: users[0].id, memberIds: [users[1].id], createdAt: timestamp });
  const id = created.conversation.id;
  await assert.rejects(storage.conversations.renameGroup({ conversationId: id, actorId: users[1].id, title: 'Nope', updatedAt: timestamp }), { code: 'GROUP_FORBIDDEN' });
  const renamed = await storage.conversations.renameGroup({ conversationId: id, actorId: users[0].id, title: 'Renamed group', updatedAt: timestamp });
  assert.equal(renamed.title, 'Renamed group');
  const added = await storage.conversations.addGroupMembers({ conversationId: id, actorId: users[0].id, memberIds: [users[2].id, users[2].id], joinedAt: timestamp, updatedAt: timestamp });
  assert.equal(added.added.length, 1);
  assert.equal(await storage.conversations.isMember(id, users[2].id), true);
  const promoted = await storage.conversations.setGroupMemberRole({ conversationId: id, actorId: users[0].id, targetUserId: users[2].id, role: 'admin', updatedAt: timestamp });
  assert.equal(promoted.memberRoles[users[2].id], 'admin');
  await assert.rejects(storage.conversations.setGroupMemberRole({ conversationId: id, actorId: users[1].id, targetUserId: users[2].id, role: 'member', updatedAt: timestamp }), { code: 'GROUP_OWNER_REQUIRED' });
  await assert.rejects(storage.conversations.removeGroupMember({ conversationId: id, actorId: users[1].id, targetUserId: users[2].id, updatedAt: timestamp }), { code: 'GROUP_FORBIDDEN' });
  await assert.rejects(storage.conversations.removeGroupMember({ conversationId: id, actorId: users[0].id, targetUserId: users[0].id, updatedAt: timestamp }), { code: 'GROUP_OWNER_PROTECTED' });
  const updated = await storage.conversations.removeGroupMember({ conversationId: id, actorId: users[0].id, targetUserId: users[2].id, updatedAt: timestamp });
  assert.equal(updated.memberIds.includes(users[2].id), false);
  assert.equal(await storage.conversations.isMember(id, users[2].id), false);
});


test('JSON storage persists last-seen timestamps without changing public identity fields', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wasl-last-seen-'));
  const file = path.join(dir, 'store.json');
  const storage = createJsonStorage(file);
  await storage.init();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const createdAt = '2026-10-28T00:00:00.000Z';
  await storage.users.create({ id: 'usr_seen', name: 'Seen', email: 'seen@example.invalid', passwordHash: 'hash', createdAt });
  const lastSeenAt = '2026-10-28T01:00:00.000Z';
  await storage.users.setLastSeen('usr_seen', lastSeenAt);
  assert.equal((await storage.users.getById('usr_seen')).lastSeenAt, lastSeenAt);
  const reloaded = createJsonStorage(file); await reloaded.init();
  assert.equal((await reloaded.users.getById('usr_seen')).lastSeenAt, lastSeenAt);
  assert.equal(reloaded.publicUser(await reloaded.users.getById('usr_seen')).lastSeenAt, lastSeenAt);
});
