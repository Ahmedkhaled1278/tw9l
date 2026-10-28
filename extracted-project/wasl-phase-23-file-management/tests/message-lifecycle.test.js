'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createJsonStorage } = require('../server/storage/json');

test('message lifecycle enforces ownership, supports replies, soft deletion, pinning and read receipts', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wasl-message-life-'));
  const storage = createJsonStorage(path.join(dir, 'store.json'));
  await storage.init(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const at = new Date().toISOString();
  const users = [
    { id: 'usr_alice', name: 'Alice', email: 'alice@example.invalid', passwordHash: 'hash', createdAt: at },
    { id: 'usr_bob', name: 'Bob', email: 'bob@example.invalid', passwordHash: 'hash', createdAt: at },
    { id: 'usr_outsider', name: 'Outside', email: 'outside@example.invalid', passwordHash: 'hash', createdAt: at }
  ];
  for (const user of users) await storage.users.create(user);
  const conversation = (await storage.conversations.createDirect({ title: 'Direct', userId: users[0].id, recipientId: users[1].id, createdAt: at })).conversation;
  const first = await storage.messages.create({ id: 'msg_first', conversationId: conversation.id, senderId: users[0].id, text: 'hello', createdAt: at, attachment: null });
  assert.equal(first.text, 'hello');
  const reply = await storage.messages.create({ id: 'msg_reply', conversationId: conversation.id, senderId: users[1].id, text: 'reply', createdAt: new Date(Date.parse(at)+1000).toISOString(), replyToMessageId: first.id, attachment: null });
  assert.equal(reply.replyToMessageId, first.id);
  await assert.rejects(storage.messages.edit({ messageId: first.id, conversationId: conversation.id, actorId: users[1].id, text: 'hacked', editedAt: at }), { code: 'MESSAGE_FORBIDDEN' });
  const edited = await storage.messages.edit({ messageId: first.id, conversationId: conversation.id, actorId: users[0].id, text: 'updated', editedAt: new Date(Date.parse(at)+2000).toISOString() });
  assert.equal(edited.text, 'updated'); assert.ok(edited.editedAt);
  const pinned = await storage.messages.setPinned({ messageId: first.id, conversationId: conversation.id, actorId: users[1].id, pinned: true, updatedAt: at });
  assert.equal(pinned.pinnedBy, users[1].id);
  const read = await storage.messages.markRead({ conversationId: conversation.id, userId: users[1].id, messageId: reply.id, readAt: at });
  assert.ok(read.includes(first.id));
  const listed = await storage.messages.listForConversation(conversation.id, { limit: 20 });
  assert.ok(listed.find(m => m.id === first.id).readBy.includes(users[1].id));
  await assert.rejects(storage.messages.remove({ messageId: first.id, conversationId: conversation.id, actorId: users[1].id, deletedAt: at }), { code: 'MESSAGE_FORBIDDEN' });
  const deleted = await storage.messages.remove({ messageId: first.id, conversationId: conversation.id, actorId: users[0].id, deletedAt: new Date(Date.parse(at)+3000).toISOString() });
  assert.equal(deleted.deleted, true); assert.equal(deleted.text, ''); assert.equal(deleted.pinnedAt, null);
  await assert.rejects(storage.messages.edit({ messageId: first.id, conversationId: conversation.id, actorId: users[0].id, text: 'again', editedAt: at }), { code: 'MESSAGE_NOT_FOUND' });
  await assert.rejects(storage.messages.setPinned({ messageId: reply.id, conversationId: conversation.id, actorId: users[2].id, pinned: true, updatedAt: at }), { code: 'MESSAGE_NOT_FOUND' });
});

test('message references must point to an existing non-deleted message in the same conversation', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wasl-message-ref-'));
  const storage = createJsonStorage(path.join(dir, 'store.json'));
  await storage.init(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const at = new Date().toISOString();
  for (const [id,email] of [['usr_a','a@example.invalid'],['usr_b','b@example.invalid'],['usr_c','c@example.invalid']]) await storage.users.create({ id, name:id, email, passwordHash:'hash', createdAt:at });
  const c1 = (await storage.conversations.createDirect({ title:'one', userId:'usr_a', recipientId:'usr_b', createdAt:at })).conversation;
  const c2 = (await storage.conversations.createDirect({ title:'two', userId:'usr_a', recipientId:'usr_c', createdAt:at })).conversation;
  const source = await storage.messages.create({ id:'msg_source', conversationId:c1.id, senderId:'usr_a', text:'source', createdAt:at });
  await assert.rejects(storage.messages.create({ id:'msg_bad', conversationId:c2.id, senderId:'usr_a', text:'bad reply', createdAt:at, replyToMessageId:source.id }), { code:'MESSAGE_REFERENCE_INVALID' });
});
