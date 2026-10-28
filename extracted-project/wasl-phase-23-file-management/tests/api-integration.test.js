'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  return port;
}
async function waitForHealth(baseUrl, child, output) {
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) throw new Error(`Server exited before becoming healthy.\n${output()}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not become healthy.\n${output()}`);
}

const dependenciesAvailable = ['express', 'bcryptjs', 'jsonwebtoken', 'socket.io'].every(name => { try { require.resolve(name); return true; } catch { return false; } });

test('HTTP API supports registration, authentication, direct conversations, messages and membership denial', { skip: !dependenciesAvailable && 'Run npm install to enable HTTP integration tests.' }, async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'wasl-api-test-'));
  const suffix = crypto.randomUUID().slice(0, 12);
  const emails = { alice: `alice-${suffix}@example.invalid`, bob: `bob-${suffix}@example.invalid`, eve: `eve-${suffix}@example.invalid`, missing: `missing-${suffix}@example.invalid` };
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    NODE_ENV: 'test', HOST: '127.0.0.1', PORT: String(port),
    JWT_SECRET: 'test-secret-that-is-longer-than-thirty-two-characters',
    DATA_DIR: path.join(temp, 'data'), UPLOAD_DIR: path.join(temp, 'uploads'),
    CORS_ORIGIN: baseUrl
  };
  let logs = '';
  const child = spawn(process.execPath, ['server/index.js'], { cwd: path.resolve(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8').on('data', chunk => { logs += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { logs += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 3000))]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    await fs.rm(temp, { recursive: true, force: true });
    if (process.env.DATABASE_URL) {
      const { Pool } = require('pg');
      const cleanupPool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 3000 });
      try { await cleanupPool.query('DELETE FROM users WHERE email = ANY($1::text[])', [Object.values(emails)]); }
      finally { await cleanupPool.end(); }
    }
  });

  await waitForHealth(baseUrl, child, () => logs);
  const json = async (url, options = {}) => {
    const response = await fetch(`${baseUrl}${url}`, {
      ...options,
      headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) }
    });
    const body = await response.json().catch(() => ({}));
    return { response, body };
  };
  const register = async (name, email) => {
    const { response, body } = await json('/api/auth/register', { method: 'POST', body: JSON.stringify({ name, email, password: 'correct-horse-battery-staple' }) });
    assert.equal(response.status, 201, JSON.stringify(body));
    assert.ok(body.token);
    assert.equal(body.user.email, email);
    assert.equal(Object.hasOwn(body.user, 'passwordHash'), false);
    return body;
  };

  const health = await json('/api/health');
  assert.equal(health.response.status, 200);
  assert.equal(health.response.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(health.response.headers.get('content-security-policy'));
  const noAuth = await json('/api/conversations');
  assert.equal(noAuth.response.status, 401);
  const rejectedOrigin = await fetch(`${baseUrl}/api/health`, { headers: { origin: 'https://attacker.example' } });
  assert.equal(rejectedOrigin.status, 403);

  const storageNoAuth = await json('/api/account/storage');
  assert.equal(storageNoAuth.response.status, 401);

  const alice = await register('Alice', emails.alice);
  const initialStorage = await json('/api/account/storage', { headers: { authorization: `Bearer ${alice.token}` } });
  assert.equal(initialStorage.response.status, 200, JSON.stringify(initialStorage.body));
  assert.equal(initialStorage.body.files, 0);
  assert.equal(initialStorage.body.usedBytes, 0);
  assert.ok(initialStorage.body.quotaBytes >= 10 * 1024 * 1024);
  const initialStorageFiles = await json('/api/account/storage/files', { headers: { authorization: `Bearer ${alice.token}` } });
  assert.equal(initialStorageFiles.response.status, 200);
  assert.deepEqual(initialStorageFiles.body.files, []);
  const privateStorageFiles = await json('/api/account/storage/files');
  assert.equal(privateStorageFiles.response.status, 401);
  const bob = await register('Bob', emails.bob);
  const eve = await register('Eve', emails.eve);

  const login = await json('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: emails.alice, password: 'correct-horse-battery-staple' }) });
  assert.equal(login.response.status, 200);
  assert.ok(login.body.token);
  const badLogin = await json('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: emails.alice, password: 'wrong-password' }) });
  assert.equal(badLogin.response.status, 401);
  const badPasswordRegistration = await json('/api/auth/register', { method: 'POST', body: JSON.stringify({ name: 'Short', email: `short-${suffix}@example.invalid`, password: 'tiny' }) });
  assert.equal(badPasswordRegistration.response.status, 400);
  const aliceSessions = await json('/api/auth/sessions', { headers: { authorization: `Bearer ${alice.token}` } });
  assert.equal(aliceSessions.response.status, 200);
  assert.ok(aliceSessions.body.sessions.some(session => session.current));
  const bobCannotRevokeAlice = await json(`/api/auth/sessions/${aliceSessions.body.sessions[0].id}`, { method: 'DELETE', headers: { authorization: `Bearer ${bob.token}` } });
  assert.equal(bobCannotRevokeAlice.response.status, 404);
  const invalidPrivacy = await json('/api/account/privacy', { method: 'PATCH', headers: { authorization: `Bearer ${alice.token}` }, body: JSON.stringify({ showLastSeen: 'everyone-on-the-internet' }) });
  assert.equal(invalidPrivacy.response.status, 400);
  const profileUpdated = await json('/api/account/profile', { method: 'PATCH', headers: { authorization: `Bearer ${alice.token}` }, body: JSON.stringify({ name: 'Alice Updated' }) });
  assert.equal(profileUpdated.response.status, 200, JSON.stringify(profileUpdated.body));
  assert.equal(profileUpdated.body.user.name, 'Alice Updated');
  assert.equal(Object.hasOwn(profileUpdated.body.user, 'passwordHash'), false);
  const shortProfileName = await json('/api/account/profile', { method: 'PATCH', headers: { authorization: `Bearer ${alice.token}` }, body: JSON.stringify({ name: 'A' }) });
  assert.equal(shortProfileName.response.status, 400);
  const longProfileName = await json('/api/account/profile', { method: 'PATCH', headers: { authorization: `Bearer ${alice.token}` }, body: JSON.stringify({ name: 'X'.repeat(41) }) });
  assert.equal(longProfileName.response.status, 400);
  const profileUnauthenticated = await json('/api/account/profile', { method: 'PATCH', body: JSON.stringify({ name: 'Intruder' }) });
  assert.equal(profileUnauthenticated.response.status, 401);

  const avatarUnauthenticated = await fetch(`${baseUrl}/api/account/avatar/${encodeURIComponent(alice.user.id)}`);
  assert.equal(avatarUnauthenticated.status, 401);
  const invalidAvatarForm = new FormData();
  invalidAvatarForm.append('avatar', new Blob([Buffer.from('not-an-image')], { type: 'image/png' }), 'fake.png');
  const invalidAvatar = await fetch(`${baseUrl}/api/account/avatar`, { method: 'POST', headers: { authorization: `Bearer ${alice.token}` }, body: invalidAvatarForm });
  assert.equal(invalidAvatar.status, 415);
  const avatarForm = new FormData();
  avatarForm.append('avatar', new Blob([Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0])], { type: 'image/png' }), 'avatar.png');
  const avatarUpload = await fetch(`${baseUrl}/api/account/avatar`, { method: 'POST', headers: { authorization: `Bearer ${alice.token}` }, body: avatarForm });
  const avatarUploadBody = await avatarUpload.json();
  assert.equal(avatarUpload.status, 201, JSON.stringify(avatarUploadBody));
  assert.equal(avatarUploadBody.user.avatarUrl, `/api/account/avatar/${encodeURIComponent(alice.user.id)}`);
  assert.equal(Object.hasOwn(avatarUploadBody.user, 'passwordHash'), false);
  assert.equal(Object.hasOwn(avatarUploadBody.user, 'avatarStorageName'), false);
  const avatarRead = await fetch(`${baseUrl}${avatarUploadBody.user.avatarUrl}`, { headers: { authorization: `Bearer ${bob.token}` } });
  assert.equal(avatarRead.status, 200);
  assert.equal(avatarRead.headers.get('content-type'), 'image/png');
  assert.equal(avatarRead.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await avatarRead.arrayBuffer()), Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]));
  const avatarDelete = await json('/api/account/avatar', { method: 'DELETE', headers: { authorization: `Bearer ${alice.token}` } });
  assert.equal(avatarDelete.response.status, 200);
  assert.equal(avatarDelete.body.user.avatarUrl, null);
  const avatarAfterDelete = await fetch(`${baseUrl}/api/account/avatar/${encodeURIComponent(alice.user.id)}`, { headers: { authorization: `Bearer ${bob.token}` } });
  assert.equal(avatarAfterDelete.status, 404);

  const created = await json('/api/conversations', { method: 'POST', headers: { authorization: `Bearer ${alice.token}` }, body: JSON.stringify({ recipientEmail: emails.bob }) });
  assert.equal(created.response.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.created, true);
  const conversationId = created.body.conversation.id;
  const repeated = await json('/api/conversations', { method: 'POST', headers: { authorization: `Bearer ${bob.token}` }, body: JSON.stringify({ recipientEmail: emails.alice }) });
  assert.equal(repeated.response.status, 200);
  assert.equal(repeated.body.created, false);
  assert.equal(repeated.body.conversation.id, conversationId);

  const sent = await json(`/api/conversations/${conversationId}/messages`, { method: 'POST', headers: { authorization: `Bearer ${alice.token}` }, body: JSON.stringify({ text: 'Hello from integration test' }) });
  assert.equal(sent.response.status, 201, JSON.stringify(sent.body));
  assert.equal(sent.body.message.text, 'Hello from integration test');
  const oversized = await json(`/api/conversations/${conversationId}/messages`, { method: 'POST', headers: { authorization: `Bearer ${alice.token}` }, body: JSON.stringify({ text: 'x'.repeat(2001) }) });
  assert.equal(oversized.response.status, 400);

  const listed = await json(`/api/conversations/${conversationId}/messages`, { headers: { authorization: `Bearer ${bob.token}` } });
  assert.equal(listed.response.status, 200);
  assert.equal(listed.body.messages.length, 1);
  assert.equal(listed.body.messages[0].text, 'Hello from integration test');

  const edited = await json(`/api/conversations/${conversationId}/messages/${sent.body.message.id}`, { method: 'PATCH', headers: { authorization: `Bearer ${alice.token}` }, body: JSON.stringify({ text: 'Edited integration message' }) });
  assert.equal(edited.response.status, 200, JSON.stringify(edited.body));
  assert.equal(edited.body.message.text, 'Edited integration message');
  const editDenied = await json(`/api/conversations/${conversationId}/messages/${sent.body.message.id}`, { method: 'PATCH', headers: { authorization: `Bearer ${bob.token}` }, body: JSON.stringify({ text: 'Not my message' }) });
  assert.equal(editDenied.response.status, 403);
  const reply = await json(`/api/conversations/${conversationId}/messages`, { method: 'POST', headers: { authorization: `Bearer ${bob.token}` }, body: JSON.stringify({ text: 'A reply', replyToMessageId: sent.body.message.id }) });
  assert.equal(reply.response.status, 201, JSON.stringify(reply.body));
  assert.equal(reply.body.message.replyToMessageId, sent.body.message.id);
  const read = await json(`/api/conversations/${conversationId}/read`, { method: 'POST', headers: { authorization: `Bearer ${alice.token}` }, body: JSON.stringify({ messageId: reply.body.message.id }) });
  assert.equal(read.response.status, 200, JSON.stringify(read.body));
  assert.ok(read.body.messageIds.includes(reply.body.message.id));
  const pinned = await json(`/api/conversations/${conversationId}/messages/${reply.body.message.id}/pin`, { method: 'PATCH', headers: { authorization: `Bearer ${alice.token}` }, body: JSON.stringify({ pinned: true }) });
  assert.equal(pinned.response.status, 200, JSON.stringify(pinned.body));
  assert.ok(pinned.body.message.pinnedAt);
  const deleted = await json(`/api/conversations/${conversationId}/messages/${reply.body.message.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${bob.token}` } });
  assert.equal(deleted.response.status, 200, JSON.stringify(deleted.body));
  assert.equal(deleted.body.message.deleted, true);
  const editDeleted = await json(`/api/conversations/${conversationId}/messages/${reply.body.message.id}`, { method: 'PATCH', headers: { authorization: `Bearer ${bob.token}` }, body: JSON.stringify({ text: 'Undelete?' }) });
  assert.equal(editDeleted.response.status, 404);

  const denied = await json(`/api/conversations/${conversationId}/messages`, { headers: { authorization: `Bearer ${eve.token}` } });
  assert.equal(denied.response.status, 404);
  const deniedPost = await json(`/api/conversations/${conversationId}/messages`, { method: 'POST', headers: { authorization: `Bearer ${eve.token}` }, body: JSON.stringify({ text: 'should not send' }) });
  assert.equal(deniedPost.response.status, 404);

  const invalidGroup = await json('/api/groups', { method: 'POST', headers: { authorization: `Bearer ${alice.token}` }, body: JSON.stringify({ title: 'A', memberEmails: [emails.bob] }) });
  assert.equal(invalidGroup.response.status, 400);
  const missingMember = await json('/api/groups', { method: 'POST', headers: { authorization: `Bearer ${alice.token}` }, body: JSON.stringify({ title: 'Project Team', memberEmails: [emails.missing] }) });
  assert.equal(missingMember.response.status, 404);

  const group = await json('/api/groups', { method: 'POST', headers: { authorization: `Bearer ${alice.token}` }, body: JSON.stringify({ title: 'Project Team', memberEmails: [emails.bob.toUpperCase(), emails.eve, emails.bob] }) });
  assert.equal(group.response.status, 201, JSON.stringify(group.body));
  assert.equal(group.body.conversation.type, 'group');
  assert.equal(new Set(group.body.conversation.memberIds).size, 3);
  assert.equal(group.body.conversation.memberRoles[alice.user.id], 'owner');
  const bobGroups = await json('/api/conversations', { headers: { authorization: `Bearer ${bob.token}` } });
  assert.ok(bobGroups.body.conversations.some(c => c.id === group.body.conversation.id));
  const groupMessage = await json(`/api/conversations/${group.body.conversation.id}/messages`, { method: 'POST', headers: { authorization: `Bearer ${bob.token}` }, body: JSON.stringify({ text: 'Group hello' }) });
  assert.equal(groupMessage.response.status, 201, JSON.stringify(groupMessage.body));
  const outsiderGroupMessages = await json(`/api/conversations/${group.body.conversation.id}/messages`, { headers: { authorization: `Bearer ${eve.token}` } });
  // Eve was deliberately included as a member, so this request must be allowed.
  assert.equal(outsiderGroupMessages.response.status, 200);

  const forbiddenRename = await json(`/api/groups/${group.body.conversation.id}`, { method: 'PATCH', headers: { authorization: `Bearer ${bob.token}` }, body: JSON.stringify({ title: 'Not allowed' }) });
  assert.equal(forbiddenRename.response.status, 403);
  const renamedGroup = await json(`/api/groups/${group.body.conversation.id}`, { method: 'PATCH', headers: { authorization: `Bearer ${alice.token}` }, body: JSON.stringify({ title: 'Project Team Updated' }) });
  assert.equal(renamedGroup.response.status, 200, JSON.stringify(renamedGroup.body));
  assert.equal(renamedGroup.body.conversation.title, 'Project Team Updated');
  const promotedAdmin = await json(`/api/groups/${group.body.conversation.id}/members/${bob.user.id}/role`, { method: 'PATCH', headers: { authorization: `Bearer ${alice.token}` }, body: JSON.stringify({ role: 'admin' }) });
  assert.equal(promotedAdmin.response.status, 200, JSON.stringify(promotedAdmin.body));
  assert.equal(promotedAdmin.body.conversation.memberRoles[bob.user.id], 'admin');
  const adminRename = await json(`/api/groups/${group.body.conversation.id}`, { method: 'PATCH', headers: { authorization: `Bearer ${bob.token}` }, body: JSON.stringify({ title: 'Renamed by admin' }) });
  assert.equal(adminRename.response.status, 200, JSON.stringify(adminRename.body));
  const memberCannotChangeRole = await json(`/api/groups/${group.body.conversation.id}/members/${eve.user.id}/role`, { method: 'PATCH', headers: { authorization: `Bearer ${bob.token}` }, body: JSON.stringify({ role: 'admin' }) });
  assert.equal(memberCannotChangeRole.response.status, 403);
  const demotedAdmin = await json(`/api/groups/${group.body.conversation.id}/members/${bob.user.id}/role`, { method: 'PATCH', headers: { authorization: `Bearer ${alice.token}` }, body: JSON.stringify({ role: 'member' }) });
  assert.equal(demotedAdmin.response.status, 200, JSON.stringify(demotedAdmin.body));
  const addedGroupMember = await json(`/api/groups/${group.body.conversation.id}/members`, { method: 'POST', headers: { authorization: `Bearer ${alice.token}` }, body: JSON.stringify({ memberEmails: [emails.eve] }) });
  assert.equal(addedGroupMember.response.status, 200, JSON.stringify(addedGroupMember.body));
  assert.equal(addedGroupMember.body.addedCount, 0); // Existing members are not duplicated.
  const protectedOwner = await json(`/api/groups/${group.body.conversation.id}/members/${alice.user.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${alice.token}` } });
  assert.equal(protectedOwner.response.status, 400);
  const removedMember = await json(`/api/groups/${group.body.conversation.id}/members/${eve.user.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${alice.token}` } });
  assert.equal(removedMember.response.status, 200, JSON.stringify(removedMember.body));
  assert.equal(removedMember.body.conversation.memberIds.includes(eve.user.id), false);
  const evictedCannotRead = await json(`/api/conversations/${group.body.conversation.id}/messages`, { headers: { authorization: `Bearer ${eve.token}` } });
  assert.equal(evictedCannotRead.response.status, 404);

  const burstStarted = performance.now();
  const burst = await Promise.all(Array.from({ length: 25 }, (_, i) => json(`/api/conversations/${conversationId}/messages`, { method: 'POST', headers: { authorization: `Bearer ${alice.token}` }, body: JSON.stringify({ text: `bounded-load-${i}` }) })));
  const burstDurationMs = performance.now() - burstStarted;
  assert.ok(burst.every(item => item.response.status === 201), `Load burst had failures: ${burst.filter(item => item.response.status !== 201).map(item => item.response.status).join(', ')}`);
  assert.ok(burstDurationMs < 15000, `25-message API burst took too long: ${Math.round(burstDurationMs)}ms`);
  t.diagnostic(`25-message API burst: ${Math.round(burstDurationMs)}ms (${process.env.DATABASE_URL ? 'PostgreSQL' : 'JSON'} storage)`);
});
