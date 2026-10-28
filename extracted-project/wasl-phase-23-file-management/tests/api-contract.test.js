'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

test('HTTP routes depend on storage repositories, not the old in-memory PostgreSQL snapshot', () => {
  const src = read('server/index.js');
  for (const route of ["'/api/health'", "'/api/auth/register'", "'/api/auth/login'", "'/api/auth/me'", "'/api/conversations'", "'/api/groups'", "'/api/conversations/:id/messages'", "'/api/uploads'", "'message:new'", "'conversation:join'"]) assert.ok(src.includes(route), `missing route/event ${route}`);
  assert.match(src, /storage\.conversations\.listForUser/);
  assert.match(src, /storage\.messages\.listForConversation/);
  assert.doesNotMatch(src, /store\.data|store\.mutate|postgres-store/);
});
test('group creation uses repository APIs and stores explicit group type and owner role', () => {
  const api = read('server/index.js');
  const json = read('server/storage/json/index.js');
  const pg = read('server/storage/pg/index.js');
  assert.match(api, /app\.post\('\/api\/groups'/);
  assert.match(api, /memberEmails/);
  assert.match(json, /createGroup:/);
  assert.match(json, /type: 'group'/);
  assert.match(pg, /async createGroup/);
  assert.match(pg, /'owner'/);
});
test('repository layer owns prefixed IDs and direct chats are inserted atomically in PostgreSQL', () => {
  const pg = read('server/storage/pg/index.js');
  const pool = read('server/storage/pg/pool.js');
  assert.match(pg, /\$\{prefix\}_\$\{crypto\.randomUUID\(\)\}/);
  assert.match(pg, /ON CONFLICT \(dm_user_low,dm_user_high\) WHERE type='direct' DO NOTHING RETURNING \*/);
  assert.match(pg, /conversation_members/);
  assert.match(pool, /async function withTransaction/);
  assert.match(pool, /BEGIN/); assert.match(pool, /COMMIT/); assert.match(pool, /ROLLBACK/);
});
test('normalized schema uses text IDs, case-insensitive email uniqueness and direct-pair uniqueness', () => {
  const sql = read('migrations/001_init.sql');
  for (const table of ['users','conversations','conversation_members','messages','attachments']) assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  assert.match(sql, /id text PRIMARY KEY/);
  assert.match(sql, /users_email_lower_uq ON users \(lower\(email\)\)/);
  assert.match(sql, /conversations_direct_pair_uq/);
  assert.match(sql, /status IN \('staged','attached','orphaned'\)/);
});
test('phase-4 preflight is read-only and recognizes actual prefixed IDs', () => {
  const sql = read('migrations/100_preflight.sql');
  assert.match(sql, /wasl_users/); assert.match(sql, /CROSS JOIN LATERAL jsonb_object_keys/);
  assert.match(sql, /\^usr_/); assert.match(sql, /\^cnv_/); assert.match(sql, /\^msg_/); assert.match(sql, /\^att_/);
  assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP)\b/i);
});
test('phase-4 migration preserves IDs and aborts on ambiguous legacy membership', () => {
  const sql = read('migrations/101_migrate_phase4.sql');
  for (const field of ['memberIds','passwordHash','conversationId','senderId','uploadedBy','storageName','originalName','mimeType']) assert.ok(sql.includes(field), `missing legacy field ${field}`);
  assert.match(sql, /jsonb_array_length\(payload->'memberIds'\) < 2/);
  assert.match(sql, /THEN 'direct' ELSE 'group' END/);
  assert.match(sql, /ON CONFLICT \(id\) DO NOTHING/);
  assert.match(sql, /COMMIT/);
  assert.doesNotMatch(sql, /ASSUMPTION/i);
});
test('upload path checks file signatures and download authorization uses membership repository', () => {
  const src = read('server/index.js');
  assert.match(src, /validateFileSignature/);
  assert.match(src, /storage\.conversations\.isMember/);
  assert.match(src, /path\.basename\(req\.file\.filename\)/);
  assert.match(src, /Content-Disposition/);
});
test('JSON adapter preserves compatibility with the existing JSON file format', () => {
  const store = read('server/store.js'); const adapter = read('server/storage/json/index.js');
  assert.match(store, /JSON\.parse\(raw\)/);
  assert.match(store, /await fs\.rename\(temp, this\.filePath\)/);
  assert.match(adapter, /createDirect/); assert.match(adapter, /createWithMessage/);
});


test('phase-4 migration blocks duplicate direct pairs and duplicate storage paths', () => {
  const sql = read('migrations/101_migrate_phase4.sql');
  assert.match(sql, /Duplicate legacy direct conversations exist/);
  assert.match(sql, /Duplicate attachment storageName values exist/);
  assert.match(sql, /CROSS JOIN LATERAL jsonb_array_elements_text/);
});

test('post-migration checks cover referential integrity and direct-pair validity', () => {
  const sql = read('migrations/102_post_migration_checks.sql');
  for (const check of ['messages_without_conversation','messages_without_sender','attachments_without_conversation','attachments_without_uploader','members_without_user','direct_without_pair','attached_message_mismatch']) assert.ok(sql.includes(check), `missing post-migration check: ${check}`);
});


test('profile avatar routes require authentication and validate image signatures', () => {
  const api = read('server/index.js');
  const pg = read('server/storage/pg/index.js');
  const json = read('server/storage/json/index.js');
  assert.match(api, /app\.post\('\/api\/account\/avatar', auth, avatarUpload\.single\('avatar'\)/);
  assert.match(api, /app\.delete\('\/api\/account\/avatar', auth/);
  assert.match(api, /app\.get\('\/api\/account\/avatar\/:userId', auth/);
  assert.match(api, /1024 \* 1024/);
  assert.match(api, /validAvatarSignature/);
  assert.match(pg, /avatar_storage_name/); assert.match(json, /updateAvatar/);
  assert.match(api, /X-Content-Type-Options/);
});


test('profile avatar migration is additive and fresh PostgreSQL schemas include avatar metadata', () => {
  const migration = read('migrations/106_phase21_profile_avatars.sql');
  const fresh = read('migrations/001_init.sql');
  assert.match(migration, /ADD COLUMN IF NOT EXISTS avatar_storage_name/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS avatar_mime_type/);
  assert.match(migration, /VALUES\(106,'phase21_profile_avatars'\)/);
  assert.match(fresh, /avatar_storage_name text/);
  assert.match(fresh, /avatar_mime_type text/);
});


test('phase 22 exposes authenticated storage usage and enforces account quota before attachment persistence', () => {
  const api = read('server/index.js');
  const json = read('server/storage/json/index.js');
  const pg = read('server/storage/pg/index.js');
  const ui = read('website/index.html');
  const app = read('website/app.js');
  assert.match(api, /app\.get\('\/api\/account\/storage', auth/);
  assert.match(api, /ACCOUNT_STORAGE_QUOTA_MB/);
  assert.match(api, /ACCOUNT_STORAGE_QUOTA_EXCEEDED/);
  assert.match(json, /getUsageForUser: async userId/);
  assert.match(pg, /getUsageForUser\(userId\)/);
  assert.match(pg, /SUM\(size_bytes\)/);
  assert.match(ui, /data-settings-tab="storage"/);
  assert.match(ui, /id="storageMeterFill"/);
  assert.match(app, /compressAvatarImage/);
  assert.match(app, /loadStorageUsage/);
});


test('phase 23 provides authenticated file listing and owner-only attachment deletion', () => {
  const api = read('server/index.js');
  const json = read('server/storage/json/index.js');
  const pg = read('server/storage/pg/index.js');
  const ui = read('website/app.js');
  assert.match(api, /app\.get\('\/api\/account\/storage\/files', auth/);
  assert.match(api, /app\.delete\('\/api\/account\/storage\/files\/:attachmentId', auth/);
  assert.match(json, /listForUser: async userId/);
  assert.match(json, /removeForUser: async/);
  assert.match(pg, /async listForUser\(userId\)/);
  assert.match(pg, /async removeForUser\(/);
  assert.match(ui, /settingsStorageFiles/);
  assert.match(ui, /تم حذف الملف وتحديث مساحة التخزين/);
});
