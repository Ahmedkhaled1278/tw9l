'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createJsonStorage } = require('../server/storage/json');

test('attachment file listing and owner-only deletion update message and storage usage', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wasl-storage-files-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'store.json');
  const seed = {
    users: [{ id: 'usr_owner', name: 'Owner', email: 'owner@example.invalid' }, { id: 'usr_other', name: 'Other', email: 'other@example.invalid' }],
    conversations: [{ id: 'cnv_test', type: 'direct', memberIds: ['usr_owner','usr_other'], memberRoles: {}, createdAt: '2026-01-01T00:00:00.000Z' }],
    messages: [{ id: 'msg_file', conversationId: 'cnv_test', senderId: 'usr_owner', text: '', attachment: { id: 'att_test' }, createdAt: '2026-01-01T00:00:00.000Z', deletedAt: null }],
    attachments: [{ id: 'att_test', conversationId: 'cnv_test', uploadedBy: 'usr_owner', storageName: 'random-file.pdf', originalName: 'notes.pdf', mimeType: 'application/pdf', size: 2048, createdAt: '2026-01-01T00:00:00.000Z' }]
  };
  await fs.writeFile(file, JSON.stringify(seed));
  const storage = createJsonStorage(file);
  await storage.init();
  assert.equal((await storage.attachments.getUsageForUser('usr_owner')).bytes, 2048);
  assert.equal((await storage.attachments.listForUser('usr_owner')).length, 1);
  assert.equal(await storage.attachments.removeForUser({ attachmentId: 'att_test', userId: 'usr_other', deletedAt: '2026-01-02T00:00:00.000Z' }), null);
  const removed = await storage.attachments.removeForUser({ attachmentId: 'att_test', userId: 'usr_owner', deletedAt: '2026-01-02T00:00:00.000Z' });
  assert.equal(removed.storageName, 'random-file.pdf');
  assert.equal((await storage.attachments.getUsageForUser('usr_owner')).bytes, 0);
  assert.equal((await storage.attachments.listForUser('usr_owner')).length, 0);
  const persisted = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(persisted.messages[0].deletedAt, '2026-01-02T00:00:00.000Z');
  assert.equal(persisted.attachments[0].status, 'orphaned');
  assert.equal(persisted.attachments[0].messageId, null);
});
