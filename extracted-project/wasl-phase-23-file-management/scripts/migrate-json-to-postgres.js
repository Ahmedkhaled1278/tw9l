'use strict';
require('dotenv').config();
const fs = require('node:fs/promises');
const path = require('node:path');
const { pool, withTransaction } = require('../server/storage/pg/pool');

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  const source = path.resolve(process.argv[2] || path.join(process.env.DATA_DIR || './data', 'wasl-store.json'));
  const raw = JSON.parse(await fs.readFile(source, 'utf8'));
  for (const key of ['users', 'conversations', 'messages']) if (!Array.isArray(raw[key])) throw new Error(`Source JSON is missing valid array: ${key}`);
  if (!Array.isArray(raw.attachments)) raw.attachments = [];
  const ids = {
    users: new Set(raw.users.map(x => x.id)),
    conversations: new Set(raw.conversations.map(x => x.id)),
    messages: new Set(raw.messages.map(x => x.id))
  };
  if (raw.users.some(u => !u.id || !u.email || !u.passwordHash)) throw new Error('A user is missing id/email/passwordHash.');
  const emails = raw.users.map(u => String(u.email).trim().toLowerCase());
  if (new Set(emails).size !== emails.length) throw new Error('Duplicate case-insensitive emails exist in JSON source.');
  for (const c of raw.conversations) {
    if (!Array.isArray(c.memberIds) || c.memberIds.length < 2 || c.memberIds.some(id => !ids.users.has(id))) throw new Error(`Conversation ${c.id} has invalid/missing members.`);
  }
  for (const m of raw.messages) if (!ids.conversations.has(m.conversationId) || !ids.users.has(m.senderId) || typeof (m.text ?? m.body) !== 'string') throw new Error(`Message ${m.id} has invalid conversation/sender/body.`);
  for (const a of raw.attachments) if (!ids.conversations.has(a.conversationId) || !ids.users.has(a.uploadedBy) || !a.storageName) throw new Error(`Attachment ${a.id} has invalid references/storageName.`);
  const linkedMessageByAttachment = new Map();
  for (const m of raw.messages) if (m.attachment?.id) linkedMessageByAttachment.set(m.attachment.id, m.id);

  try {
    await withTransaction(async client => {
      const target = await client.query(`SELECT
        (SELECT count(*) FROM users) AS users,
        (SELECT count(*) FROM conversations) AS conversations,
        (SELECT count(*) FROM messages) AS messages,
        (SELECT count(*) FROM attachments) AS attachments`);
      if (Object.values(target.rows[0]).some(value => Number(value) > 0)) throw new Error('Target normalized database is not empty; migration stopped.');
      for (const u of raw.users) await client.query(
        'INSERT INTO users(id,email,password_hash,display_name,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6)',
        [u.id, String(u.email).trim().toLowerCase(), u.passwordHash, u.name || u.displayName || 'Wasl user', u.createdAt || new Date().toISOString(), u.updatedAt || u.createdAt || new Date().toISOString()]);
      for (const c of raw.conversations) {
        const members = [...new Set(c.memberIds)];
        if (members.length !== c.memberIds.length) throw new Error(`Conversation ${c.id} has duplicate members.`);
        if (members.length === 2) {
          const [low, high] = [...members].sort();
          await client.query('INSERT INTO conversations(id,type,title,dm_user_low,dm_user_high,created_at,updated_at) VALUES($1,\'direct\',$2,$3,$4,$5,$6)', [c.id, c.title || 'محادثة مباشرة', low, high, c.createdAt || new Date().toISOString(), c.updatedAt || c.createdAt || new Date().toISOString()]);
        } else {
          await client.query('INSERT INTO conversations(id,type,title,dm_user_low,dm_user_high,created_at,updated_at) VALUES($1,\'group\',$2,NULL,NULL,$3,$4)', [c.id, c.title || 'مجموعة', c.createdAt || new Date().toISOString(), c.updatedAt || c.createdAt || new Date().toISOString()]);
        }
        for (const userId of members) await client.query('INSERT INTO conversation_members(conversation_id,user_id,role,joined_at) VALUES($1,$2,$3,$4)', [c.id, userId, c.ownerId === userId ? 'owner' : 'member', c.createdAt || new Date().toISOString()]);
      }
      for (const m of raw.messages) await client.query('INSERT INTO messages(id,conversation_id,sender_id,body,created_at) VALUES($1,$2,$3,$4,$5)', [m.id, m.conversationId, m.senderId, m.text ?? m.body, m.createdAt || new Date().toISOString()]);
      for (const a of raw.attachments) {
        const messageId = linkedMessageByAttachment.get(a.id) || null;
        await client.query(`INSERT INTO attachments(id,conversation_id,uploader_id,message_id,status,filename,detected_mime,size_bytes,storage_path,created_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [a.id,a.conversationId,a.uploadedBy,messageId,messageId?'attached':'orphaned',a.originalName||'attachment',a.mimeType||'application/octet-stream',Math.max(0,Number(a.size)||0),path.basename(a.storageName),a.createdAt||new Date().toISOString()]);
      }
      await client.query("INSERT INTO app_schema_migrations(version,name) VALUES(5,'json-import') ON CONFLICT(version) DO NOTHING");
    });
    console.log(`Migration complete: ${raw.users.length} users, ${raw.conversations.length} conversations, ${raw.messages.length} messages, ${raw.attachments.length} attachments.`);
    console.log('Keep the source JSON and uploaded files as a backup until post-migration checks pass.');
  } finally { await pool.end(); }
}
main().catch(err => { console.error(`Migration failed safely: ${err.message}`); process.exitCode = 1; });
