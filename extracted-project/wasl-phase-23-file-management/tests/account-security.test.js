'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createJsonStorage } = require('../server/storage/json');

async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wasl-phase17-'));
  const storage = createJsonStorage(path.join(dir, 'store.json'));
  await storage.init();
  t.after(async () => { await storage.close(); await fs.rm(dir, { recursive: true, force: true }); });
  return storage;
}

test('session revocation is scoped to its owner and removes a session from active listing', async t => {
  const s = await setup(t);
  await s.users.create({id:'usr_one',name:'One',email:'one@example.com',passwordHash:'x',createdAt:'2026-10-28T00:00:00.000Z'});
  await s.users.create({id:'usr_two',name:'Two',email:'two@example.com',passwordHash:'x',createdAt:'2026-10-28T00:00:00.000Z'});
  const session = {id:'ses_one',userId:'usr_one',createdAt:'2026-10-28T00:00:00.000Z',expiresAt:'2026-11-04T00:00:00.000Z',userAgent:'test',ip:'127.0.0.1',lastUsedAt:'2026-10-28T00:00:00.000Z',revokedAt:null};
  await s.sessions.create(session);
  assert.equal(await s.sessions.revoke({sessionId:'ses_one',userId:'usr_two',revokedAt:'2026-10-28T01:00:00.000Z'}), false);
  assert.equal((await s.sessions.listForUser('usr_one')).length, 1);
  assert.equal(await s.sessions.revoke({sessionId:'ses_one',userId:'usr_one',revokedAt:'2026-10-28T01:00:00.000Z'}), true);
  assert.equal((await s.sessions.getById('ses_one')).revokedAt, '2026-10-28T01:00:00.000Z');
  assert.equal((await s.sessions.listForUser('usr_one')).length, 0);
});

test('privacy settings update only supported fields and notifications are private per user', async t => {
  const s = await setup(t);
  for (const [id,email] of [['usr_one','one@example.com'],['usr_two','two@example.com']]) await s.users.create({id,name:id,email,passwordHash:'x',createdAt:'2026-10-28T00:00:00.000Z'});
  await s.users.setPrivacy('usr_two', {notificationsEnabled:false, showLastSeen:'nobody'});
  assert.equal((await s.users.getPrivacy('usr_two')).showLastSeen, 'nobody');
  const convo = await s.conversations.createDirect({title:'Test',userId:'usr_one',recipientId:'usr_two',createdAt:'2026-10-28T00:00:00.000Z'});
  const result = await s.notifications.createForUsers({users:['usr_one','usr_two'],conversationId:convo.conversation.id,messageId:'msg_a',senderId:'usr_sender',preview:'Hello',createdAt:'2026-10-28T00:00:00.000Z'});
  assert.deepEqual(result.map(n=>n.userId), ['usr_one']);
  assert.equal(await s.notifications.unreadCount('usr_one'), 1);
  assert.equal(await s.notifications.unreadCount('usr_two'), 0);
  assert.equal((await s.notifications.listForUser('usr_two')).length, 0);
  const marked = await s.notifications.markRead({userId:'usr_two',notificationId:result[0].id,readAt:'2026-10-28T00:01:00.000Z'});
  assert.equal(marked, null);
  assert.equal((await s.notifications.markRead({userId:'usr_one',notificationId:result[0].id,readAt:'2026-10-28T00:01:00.000Z'})).readAt,'2026-10-28T00:01:00.000Z');
  assert.equal(await s.notifications.unreadCount('usr_one'), 0);
});


test('profile updates change only the requested user and persist normalized name', async t => {
  const s = await setup(t);
  await s.users.create({id:'usr_profile_a',name:'Old Name',email:'profile-a@example.com',passwordHash:'x',createdAt:'2026-10-28T00:00:00.000Z'});
  await s.users.create({id:'usr_profile_b',name:'Other User',email:'profile-b@example.com',passwordHash:'x',createdAt:'2026-10-28T00:00:00.000Z'});
  const updated = await s.users.updateProfile('usr_profile_a', {name:'New Name',updatedAt:'2026-10-28T01:00:00.000Z'});
  assert.equal(updated.name, 'New Name');
  assert.equal((await s.users.getById('usr_profile_a')).updatedAt, '2026-10-28T01:00:00.000Z');
  assert.equal((await s.users.getById('usr_profile_b')).name, 'Other User');
});


test('profile avatar metadata is private to the account record, replaceable and removable', async t => {
  const s = await setup(t);
  await s.users.create({id:'usr_avatar',name:'Avatar User',email:'avatar@example.com',passwordHash:'x',createdAt:'2026-10-28T00:00:00.000Z'});
  const first = await s.users.updateAvatar('usr_avatar', {storageName:'01234567-89ab-cdef-0123-456789abcdef.avatar',mimeType:'image/png',updatedAt:'2026-10-28T01:00:00.000Z'});
  assert.equal(first.previous, null);
  assert.equal(first.user.avatarUrl, '/api/account/avatar/usr_avatar');
  assert.deepEqual(await s.users.getAvatar('usr_avatar'), {storageName:'01234567-89ab-cdef-0123-456789abcdef.avatar',mimeType:'image/png'});
  const second = await s.users.updateAvatar('usr_avatar', {storageName:'11234567-89ab-cdef-0123-456789abcdef.avatar',mimeType:'image/webp',updatedAt:'2026-10-28T02:00:00.000Z'});
  assert.equal(second.previous.storageName, '01234567-89ab-cdef-0123-456789abcdef.avatar');
  const removed = await s.users.updateAvatar('usr_avatar', {storageName:null,mimeType:null,updatedAt:'2026-10-28T03:00:00.000Z'});
  assert.equal(removed.previous.storageName, '11234567-89ab-cdef-0123-456789abcdef.avatar');
  assert.equal(removed.user.avatarUrl, null);
  assert.equal(await s.users.getAvatar('usr_avatar'), null);
});
