'use strict';
const crypto = require('node:crypto');
const { pool, withTransaction } = require('./pool');
const id = prefix => `${prefix}_${crypto.randomUUID()}`;
const iso = value => value instanceof Date ? value.toISOString() : new Date(value).toISOString();
const mapUser = row => row && ({ id: row.id, name: row.display_name, email: row.email, passwordHash: row.password_hash, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), lastSeenAt: row.last_seen_at ? iso(row.last_seen_at) : null, avatarStorageName: row.avatar_storage_name || null, avatarMimeType: row.avatar_mime_type || null });
const mapConversation = (row, memberIds = []) => row && ({
  id: row.id, title: row.title || 'محادثة مباشرة', type: row.type, memberIds,
  createdAt: iso(row.created_at), updatedAt: iso(row.updated_at)
});
const mapMessage = row => row && ({
  id: row.id, conversationId: row.conversation_id, senderId: row.sender_id,
  text: row.deleted_at ? '' : (row.body ?? ''), attachment: row.attachment || null,
  createdAt: iso(row.created_at), editedAt: row.edited_at ? iso(row.edited_at) : null, deleted: Boolean(row.deleted_at), deletedAt: row.deleted_at ? iso(row.deleted_at) : null,
  pinnedAt: row.pinned_at ? iso(row.pinned_at) : null, pinnedBy: row.pinned_by || null, replyToMessageId: row.reply_to_message_id || null, forwardedFromMessageId: row.forwarded_from_message_id || null, readBy: row.read_by || []
});

function createPgStorage() {
  return {
    mode: 'postgres',
    async ping() { await pool.query('SELECT 1'); return true; },
    async init() {
      // Runtime intentionally does not auto-apply DDL; use the reviewed schema/migrations.
      const check = await pool.query("SELECT to_regclass('users') AS users, to_regclass('conversations') AS conversations, to_regclass('conversation_members') AS members, to_regclass('messages') AS messages, to_regclass('attachments') AS attachments, to_regclass('message_receipts') AS message_receipts, to_regclass('user_sessions') AS user_sessions, to_regclass('notifications') AS notifications, EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='users' AND column_name='privacy_settings') AS privacy_settings_column, EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='users' AND column_name='avatar_storage_name') AS avatar_storage_name_column, EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='users' AND column_name='avatar_mime_type') AS avatar_mime_type_column");
      const missing = Object.entries(check.rows[0]).filter(([, value]) => !value).map(([key]) => key);
      if (missing.length) throw new Error(`Normalized PostgreSQL schema is missing tables: ${missing.join(', ')}. Apply migrations/001_init.sql and the applicable data migration.`);
    },
    close: () => pool.end(),
    id,
    publicUser: user => user && ({ id: user.id, name: user.name, email: user.email, createdAt: user.createdAt, lastSeenAt: user.lastSeenAt || null, avatarUrl: user.avatarStorageName ? `/api/account/avatar/${encodeURIComponent(user.id)}` : null }),
    users: {
      async getById(userId) { const { rows } = await pool.query('SELECT * FROM users WHERE id=$1', [userId]); return mapUser(rows[0]); },
      async setLastSeen(userId, lastSeenAt) { await pool.query('UPDATE users SET last_seen_at=$2 WHERE id=$1', [userId, lastSeenAt]); },
      async getByEmail(email) { const { rows } = await pool.query('SELECT * FROM users WHERE lower(email)=lower($1)', [email]); return mapUser(rows[0]); },
      async updateProfile(userId, profile) { const { rows } = await pool.query('UPDATE users SET display_name=$2, updated_at=$3 WHERE id=$1 RETURNING *', [userId, profile.name, profile.updatedAt]); return mapUser(rows[0]); },
      async getAvatar(userId) { const { rows } = await pool.query('SELECT avatar_storage_name, avatar_mime_type FROM users WHERE id=$1', [userId]); const r=rows[0]; return r?.avatar_storage_name ? { storageName:r.avatar_storage_name, mimeType:r.avatar_mime_type || null } : null; },
      async updateAvatar(userId, avatar) { return withTransaction(async client => { const old = await client.query('SELECT avatar_storage_name,avatar_mime_type FROM users WHERE id=$1 FOR UPDATE', [userId]); if (!old.rows[0]) return null; const previous = old.rows[0].avatar_storage_name ? { storageName:old.rows[0].avatar_storage_name, mimeType:old.rows[0].avatar_mime_type || null } : null; const { rows } = await client.query('UPDATE users SET avatar_storage_name=$2, avatar_mime_type=$3, updated_at=$4 WHERE id=$1 RETURNING *', [userId, avatar?.storageName || null, avatar?.mimeType || null, avatar.updatedAt]); const user=mapUser(rows[0]); return { user: { id:user.id, name:user.name, email:user.email, createdAt:user.createdAt, lastSeenAt:user.lastSeenAt || null, avatarUrl:user.avatarStorageName ? `/api/account/avatar/${encodeURIComponent(user.id)}` : null }, previous }; }); },
      async create(user) {
        try {
          const { rows } = await pool.query(
            'INSERT INTO users(id,email,password_hash,display_name,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$5) RETURNING *',
            [user.id, user.email, user.passwordHash, user.name, user.createdAt]);
          return mapUser(rows[0]);
        } catch (err) { if (err.code === '23505') throw Object.assign(new Error('EMAIL_EXISTS'), { code: 'EMAIL_EXISTS' }); throw err; }
      },
      async getPrivacy(userId) { const { rows } = await pool.query('SELECT privacy_settings FROM users WHERE id=$1', [userId]); return rows[0]?.privacy_settings || { showLastSeen: 'everyone', showOnlineStatus: 'everyone', notificationsEnabled: true }; },
      async setPrivacy(userId, settings) { const { rows } = await pool.query('UPDATE users SET privacy_settings=COALESCE(privacy_settings, $2::jsonb) || $2::jsonb, updated_at=now() WHERE id=$1 RETURNING privacy_settings', [userId, JSON.stringify(settings)]); return rows[0]?.privacy_settings || null; }
    },
    conversations: {
      async isMember(conversationId, userId) {
        const { rows } = await pool.query('SELECT 1 FROM conversation_members WHERE conversation_id=$1 AND user_id=$2', [conversationId, userId]); return rows.length > 0;
      },
      async getForMember(conversationId, userId) {
        const { rows } = await pool.query(`SELECT c.* FROM conversations c JOIN conversation_members cm ON cm.conversation_id=c.id WHERE c.id=$1 AND cm.user_id=$2`, [conversationId, userId]);
        if (!rows[0]) return null;
        const members = await pool.query('SELECT user_id FROM conversation_members WHERE conversation_id=$1 ORDER BY user_id', [conversationId]);
        return mapConversation(rows[0], members.rows.map(r => r.user_id));
      },
      async listForUser(userId) {
        const { rows } = await pool.query(`
          SELECT c.*, COALESCE((SELECT jsonb_agg(cm.user_id ORDER BY cm.user_id) FROM conversation_members cm WHERE cm.conversation_id=c.id),'[]'::jsonb) AS member_ids,
                 COALESCE((SELECT jsonb_object_agg(cm.user_id,cm.role) FROM conversation_members cm WHERE cm.conversation_id=c.id),'{}'::jsonb) AS member_roles,
                 (SELECT to_jsonb(m) FROM messages m WHERE m.conversation_id=c.id ORDER BY m.created_at DESC,m.id DESC LIMIT 1) AS last_message
          FROM conversations c JOIN conversation_members mine ON mine.conversation_id=c.id
          WHERE mine.user_id=$1 ORDER BY c.updated_at DESC`, [userId]);
        const ids = [...new Set(rows.flatMap(r => r.member_ids))];
        let users = new Map();
        if (ids.length) { const result = await pool.query('SELECT * FROM users WHERE id = ANY($1::text[])', [ids]); users = new Map(result.rows.map(r => [r.id, mapUser(r)])); }
        return rows.map(r => ({ ...mapConversation(r, r.member_ids), memberRoles: r.member_roles || {}, members: r.member_ids.map(id => users.get(id)).filter(Boolean).map(u => ({ id:u.id,name:u.name,email:u.email,createdAt:u.createdAt,lastSeenAt:u.lastSeenAt || null,avatarUrl:u.avatarStorageName ? `/api/account/avatar/${encodeURIComponent(u.id)}` : null })), lastMessage: r.last_message ? mapMessage(r.last_message) : null }));
      },
      async createDirect({ title, userId, recipientId, createdAt }) {
        const low = userId < recipientId ? userId : recipientId;
        const high = userId < recipientId ? recipientId : userId;
        const newId = id('cnv');
        return withTransaction(async client => {
          const inserted = await client.query(`INSERT INTO conversations(id,type,title,dm_user_low,dm_user_high,created_at,updated_at)
            VALUES($1,'direct',$2,$3,$4,$5,$5) ON CONFLICT (dm_user_low,dm_user_high) WHERE type='direct' DO NOTHING RETURNING *`, [newId, title || 'محادثة مباشرة', low, high, createdAt]);
          let row = inserted.rows[0]; const created = Boolean(row);
          if (!row) { const existing = await client.query("SELECT * FROM conversations WHERE type='direct' AND dm_user_low=$1 AND dm_user_high=$2", [low, high]); row = existing.rows[0]; }
          if (!row) throw new Error('Direct conversation conflict occurred but no existing conversation was found.');
          await client.query("INSERT INTO conversation_members(conversation_id,user_id,role,joined_at) VALUES($1,$2,'member',$3),($1,$4,'member',$3) ON CONFLICT DO NOTHING", [row.id, userId, createdAt, recipientId]);
          const members = await client.query('SELECT user_id FROM conversation_members WHERE conversation_id=$1 ORDER BY user_id', [row.id]);
          return { conversation: mapConversation(row, members.rows.map(r => r.user_id)), created };
        });
      },
      async createGroup({ title, userId, memberIds, createdAt }) {
        const uniqueMembers = [...new Set([userId, ...memberIds])];
        if (uniqueMembers.length < 2) throw new Error('GROUP_REQUIRES_MEMBERS');
        return withTransaction(async client => {
          const groupId = id('cnv');
          const inserted = await client.query("INSERT INTO conversations(id,type,title,dm_user_low,dm_user_high,created_at,updated_at) VALUES($1,'group',$2,NULL,NULL,$3,$3) RETURNING *", [groupId, title, createdAt]);
          for (const memberId of uniqueMembers) {
            await client.query("INSERT INTO conversation_members(conversation_id,user_id,role,joined_at) VALUES($1,$2,$3,$4)", [groupId, memberId, memberId === userId ? 'owner' : 'member', createdAt]);
          }
          return { conversation: { ...mapConversation(inserted.rows[0], uniqueMembers), memberRoles: Object.fromEntries(uniqueMembers.map(memberId => [memberId, memberId === userId ? 'owner' : 'member'])) }, created: true };
        });
      },
      async getRole(conversationId, userId) {
        const { rows } = await pool.query('SELECT cm.role,c.type FROM conversation_members cm JOIN conversations c ON c.id=cm.conversation_id WHERE cm.conversation_id=$1 AND cm.user_id=$2', [conversationId,userId]);
        return rows[0] ? rows[0].role : null;
      },
      async renameGroup({ conversationId, actorId, title, updatedAt }) {
        return withTransaction(async client => {
          const c = await client.query("SELECT * FROM conversations WHERE id=$1 FOR UPDATE", [conversationId]);
          if (!c.rows[0] || c.rows[0].type !== 'group') throw Object.assign(new Error('GROUP_NOT_FOUND'), { code: 'GROUP_NOT_FOUND' });
          const actor = await client.query('SELECT role FROM conversation_members WHERE conversation_id=$1 AND user_id=$2', [conversationId,actorId]);
          if (!actor.rows[0] || !['owner','admin'].includes(actor.rows[0].role)) throw Object.assign(new Error('GROUP_FORBIDDEN'), { code: 'GROUP_FORBIDDEN' });
          const { rows } = await client.query('UPDATE conversations SET title=$2,updated_at=$3 WHERE id=$1 RETURNING *', [conversationId,title,updatedAt]);
          const members = await client.query('SELECT user_id,role FROM conversation_members WHERE conversation_id=$1 ORDER BY user_id', [conversationId]);
          return { ...mapConversation(rows[0],members.rows.map(r=>r.user_id)), memberRoles:Object.fromEntries(members.rows.map(r=>[r.user_id,r.role])) };
        });
      },
      async addGroupMembers({ conversationId, actorId, memberIds, joinedAt, updatedAt }) {
        return withTransaction(async client => {
          const c = await client.query("SELECT * FROM conversations WHERE id=$1 FOR UPDATE", [conversationId]);
          if (!c.rows[0] || c.rows[0].type !== 'group') throw Object.assign(new Error('GROUP_NOT_FOUND'), { code: 'GROUP_NOT_FOUND' });
          const actor = await client.query('SELECT role FROM conversation_members WHERE conversation_id=$1 AND user_id=$2', [conversationId,actorId]);
          if (!actor.rows[0] || !['owner','admin'].includes(actor.rows[0].role)) throw Object.assign(new Error('GROUP_FORBIDDEN'), { code: 'GROUP_FORBIDDEN' });
          const current = await client.query('SELECT user_id FROM conversation_members WHERE conversation_id=$1', [conversationId]);
          const currentIds = new Set(current.rows.map(r=>r.user_id));
          const incoming = [...new Set(memberIds)].filter(id=>!currentIds.has(id));
          if (currentIds.size + incoming.length > 100) throw Object.assign(new Error('GROUP_LIMIT'), { code: 'GROUP_LIMIT' });
          for (const memberId of incoming) await client.query("INSERT INTO conversation_members(conversation_id,user_id,role,joined_at) VALUES($1,$2,'member',$3) ON CONFLICT DO NOTHING", [conversationId,memberId,joinedAt]);
          await client.query('UPDATE conversations SET updated_at=$2 WHERE id=$1',[conversationId,updatedAt]);
          const members = await client.query('SELECT user_id,role FROM conversation_members WHERE conversation_id=$1 ORDER BY user_id',[conversationId]);
          return { conversation:{ ...mapConversation(c.rows[0],members.rows.map(r=>r.user_id)), memberRoles:Object.fromEntries(members.rows.map(r=>[r.user_id,r.role])) }, added:incoming };
        });
      },
      async setGroupMemberRole({ conversationId, actorId, targetUserId, role, updatedAt }) {
        return withTransaction(async client => {
          const c = await client.query("SELECT * FROM conversations WHERE id=$1 FOR UPDATE", [conversationId]);
          if (!c.rows[0] || c.rows[0].type !== 'group') throw Object.assign(new Error('GROUP_NOT_FOUND'), { code: 'GROUP_NOT_FOUND' });
          const roles = await client.query('SELECT user_id,role FROM conversation_members WHERE conversation_id=$1 AND user_id=ANY($2::text[])', [conversationId,[actorId,targetUserId]]);
          const roleMap = Object.fromEntries(roles.rows.map(r=>[r.user_id,r.role]));
          if (roleMap[actorId] !== 'owner') throw Object.assign(new Error('GROUP_OWNER_REQUIRED'), { code: 'GROUP_OWNER_REQUIRED' });
          if (!roleMap[targetUserId] || roleMap[targetUserId] === 'owner') throw Object.assign(new Error('GROUP_MEMBER_NOT_FOUND'), { code: 'GROUP_MEMBER_NOT_FOUND' });
          await client.query('UPDATE conversation_members SET role=$3 WHERE conversation_id=$1 AND user_id=$2',[conversationId,targetUserId,role]);
          await client.query('UPDATE conversations SET updated_at=$2 WHERE id=$1',[conversationId,updatedAt]);
          const members = await client.query('SELECT user_id,role FROM conversation_members WHERE conversation_id=$1 ORDER BY user_id',[conversationId]);
          return { ...mapConversation(c.rows[0],members.rows.map(r=>r.user_id)), memberRoles:Object.fromEntries(members.rows.map(r=>[r.user_id,r.role])) };
        });
      },
      async removeGroupMember({ conversationId, actorId, targetUserId, updatedAt }) {
        return withTransaction(async client => {
          const c = await client.query("SELECT * FROM conversations WHERE id=$1 FOR UPDATE", [conversationId]);
          if (!c.rows[0] || c.rows[0].type !== 'group') throw Object.assign(new Error('GROUP_NOT_FOUND'), { code: 'GROUP_NOT_FOUND' });
          const roles = await client.query('SELECT user_id,role FROM conversation_members WHERE conversation_id=$1 AND user_id=ANY($2::text[])', [conversationId,[actorId,targetUserId]]);
          const roleMap = Object.fromEntries(roles.rows.map(r=>[r.user_id,r.role]));
          const actorRole = roleMap[actorId], targetRole = roleMap[targetUserId];
          if (!actorRole || !targetRole) throw Object.assign(new Error('GROUP_MEMBER_NOT_FOUND'), { code: 'GROUP_MEMBER_NOT_FOUND' });
          if (targetRole === 'owner') throw Object.assign(new Error('GROUP_OWNER_PROTECTED'), { code: 'GROUP_OWNER_PROTECTED' });
          if (actorRole !== 'owner' && !(actorRole === 'admin' && targetRole === 'member')) throw Object.assign(new Error('GROUP_FORBIDDEN'), { code: 'GROUP_FORBIDDEN' });
          await client.query('DELETE FROM conversation_members WHERE conversation_id=$1 AND user_id=$2',[conversationId,targetUserId]);
          await client.query('UPDATE conversations SET updated_at=$2 WHERE id=$1',[conversationId,updatedAt]);
          const members = await client.query('SELECT user_id,role FROM conversation_members WHERE conversation_id=$1 ORDER BY user_id',[conversationId]);
          return { ...mapConversation(c.rows[0],members.rows.map(r=>r.user_id)), memberRoles:Object.fromEntries(members.rows.map(r=>[r.user_id,r.role])) };
        });
      },
      async touch(conversationId, updatedAt) { await pool.query('UPDATE conversations SET updated_at=$2 WHERE id=$1', [conversationId, updatedAt]); }
    },
    sessions: {
      async create(s) { const { rows } = await pool.query('INSERT INTO user_sessions(id,user_id,created_at,expires_at,user_agent,ip,last_used_at) VALUES($1,$2,$3,$4,$5,$6,$3) RETURNING *', [s.id,s.userId,s.createdAt,s.expiresAt,s.userAgent || null,s.ip || null]); return {id:rows[0].id,userId:rows[0].user_id,createdAt:iso(rows[0].created_at),expiresAt:iso(rows[0].expires_at),userAgent:rows[0].user_agent,ip:rows[0].ip,lastUsedAt:iso(rows[0].last_used_at),revokedAt:null}; },
      async getById(sessionId) { const { rows } = await pool.query('SELECT * FROM user_sessions WHERE id=$1', [sessionId]); const r=rows[0]; return r && {id:r.id,userId:r.user_id,createdAt:iso(r.created_at),expiresAt:iso(r.expires_at),userAgent:r.user_agent,ip:r.ip,lastUsedAt:r.last_used_at?iso(r.last_used_at):null,revokedAt:r.revoked_at?iso(r.revoked_at):null}; },
      async listForUser(userId) { const { rows } = await pool.query('SELECT id,created_at,expires_at,user_agent,ip,last_used_at FROM user_sessions WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>now() ORDER BY created_at DESC', [userId]); return rows.map(r=>({id:r.id,createdAt:iso(r.created_at),expiresAt:iso(r.expires_at),userAgent:r.user_agent,ip:r.ip,lastUsedAt:r.last_used_at?iso(r.last_used_at):null})); },
      async revoke({sessionId,userId,revokedAt}) { const { rowCount }=await pool.query('UPDATE user_sessions SET revoked_at=$3 WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL',[sessionId,userId,revokedAt]); return rowCount>0; },
      async revokeAllExcept({userId,exceptSessionId,revokedAt}) { const {rowCount}=await pool.query('UPDATE user_sessions SET revoked_at=$3 WHERE user_id=$1 AND id<>$2 AND revoked_at IS NULL',[userId,exceptSessionId,revokedAt]); return rowCount; }
    },
    notifications: {
      async createForUsers({users,conversationId,messageId,senderId,preview,createdAt}) { const ids=[...new Set(users)].filter(id=>id!==senderId); if(!ids.length)return []; const {rows}=await pool.query(`INSERT INTO notifications(id,user_id,conversation_id,message_id,sender_id,preview,created_at) SELECT 'ntf_'||gen_random_uuid()::text,u.id,$2,$3,$4,$5,$6 FROM users u WHERE u.id=ANY($1::text[]) AND COALESCE((u.privacy_settings->>'notificationsEnabled')::boolean,true) RETURNING *`,[ids,conversationId,messageId,senderId,String(preview||'رسالة جديدة').slice(0,120),createdAt]); return rows.map(r=>({id:r.id,userId:r.user_id,conversationId:r.conversation_id,messageId:r.message_id,senderId:r.sender_id,preview:r.preview,createdAt:iso(r.created_at),readAt:r.read_at?iso(r.read_at):null})); },
      async listForUser(userId,{limit=50,before}={}) { const args=[userId,Math.min(100,Math.max(1,limit))]; if(before)args.push(before); const {rows}=await pool.query(`SELECT n.* FROM notifications n JOIN conversation_members cm ON cm.conversation_id=n.conversation_id AND cm.user_id=n.user_id WHERE n.user_id=$1 ${before?'AND n.created_at<$3':''} ORDER BY n.created_at DESC,n.id DESC LIMIT $2`,args); return rows.map(r=>({id:r.id,userId:r.user_id,conversationId:r.conversation_id,messageId:r.message_id,senderId:r.sender_id,preview:r.preview,createdAt:iso(r.created_at),readAt:r.read_at?iso(r.read_at):null})); },
      async unreadCount(userId) { const {rows}=await pool.query('SELECT count(*)::int AS count FROM notifications n JOIN conversation_members cm ON cm.conversation_id=n.conversation_id AND cm.user_id=n.user_id WHERE n.user_id=$1 AND n.read_at IS NULL',[userId]); return rows[0].count; },
      async markRead({userId,notificationId,readAt}) { const {rows}=await pool.query('UPDATE notifications n SET read_at=COALESCE(n.read_at,$3) WHERE n.id=$1 AND n.user_id=$2 AND EXISTS (SELECT 1 FROM conversation_members cm WHERE cm.conversation_id=n.conversation_id AND cm.user_id=n.user_id) RETURNING n.*',[notificationId,userId,readAt]); const r=rows[0]; return r&&({id:r.id,userId:r.user_id,conversationId:r.conversation_id,messageId:r.message_id,senderId:r.sender_id,preview:r.preview,createdAt:iso(r.created_at),readAt:iso(r.read_at)}); },
      async markAllRead({userId,readAt}) { const {rowCount}=await pool.query('UPDATE notifications n SET read_at=$2 WHERE n.user_id=$1 AND n.read_at IS NULL AND EXISTS (SELECT 1 FROM conversation_members cm WHERE cm.conversation_id=n.conversation_id AND cm.user_id=n.user_id)',[userId,readAt]); return rowCount; },
      async delete({userId,notificationId}) { const {rowCount}=await pool.query('DELETE FROM notifications WHERE id=$1 AND user_id=$2',[notificationId,userId]); return rowCount>0; }
    },
    messages: {
      async getById(messageId) {
        const { rows } = await pool.query(`SELECT m.*, COALESCE((SELECT jsonb_agg(r.user_id) FROM message_receipts r WHERE r.message_id=m.id),'[]'::jsonb) AS read_by,
          CASE WHEN a.id IS NULL THEN NULL ELSE jsonb_build_object('id',a.id,'originalName',a.filename,'mimeType',a.detected_mime,'size',a.size_bytes) END AS attachment
          FROM messages m LEFT JOIN attachments a ON a.message_id=m.id AND a.status='attached' WHERE m.id=$1`, [messageId]);
        return mapMessage(rows[0]);
      },
      async listForConversation(conversationId, { limit = 50, before } = {}) {
        const params = [conversationId, limit]; let beforeSql = '';
        if (before) { params.push(before); beforeSql = 'AND m.created_at < $3'; }
        const { rows } = await pool.query(`SELECT m.*, COALESCE((SELECT jsonb_agg(r.user_id) FROM message_receipts r WHERE r.message_id=m.id),'[]'::jsonb) AS read_by,
          CASE WHEN a.id IS NULL THEN NULL ELSE jsonb_build_object('id',a.id,'originalName',a.filename,'mimeType',a.detected_mime,'size',a.size_bytes) END AS attachment
          FROM messages m LEFT JOIN attachments a ON a.message_id=m.id AND a.status='attached'
          WHERE m.conversation_id=$1 ${beforeSql} ORDER BY m.created_at DESC,m.id DESC LIMIT $2`, params);
        return rows.reverse().map(mapMessage);
      },
      async create(message) {
        return withTransaction(async client => {
          const membership = await client.query('SELECT 1 FROM conversation_members WHERE conversation_id=$1 AND user_id=$2', [message.conversationId,message.senderId]);
          if (!membership.rows[0]) throw Object.assign(new Error('MESSAGE_NOT_FOUND'), { code: 'MESSAGE_NOT_FOUND' });
          if (message.replyToMessageId) {
            const ref = await client.query('SELECT id FROM messages WHERE id=$1 AND conversation_id=$2 AND deleted_at IS NULL', [message.replyToMessageId,message.conversationId]);
            if (!ref.rows[0]) throw Object.assign(new Error('MESSAGE_REFERENCE_INVALID'), { code: 'MESSAGE_REFERENCE_INVALID' });
          }
          const { rows } = await client.query(`INSERT INTO messages(id,conversation_id,sender_id,body,created_at,reply_to_message_id,forwarded_from_message_id)
            VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [message.id,message.conversationId,message.senderId,message.text,message.createdAt,message.replyToMessageId || null,message.forwardedFromMessageId || null]);
          await client.query('UPDATE conversations SET updated_at=$2 WHERE id=$1', [message.conversationId,message.createdAt]);
          return mapMessage(rows[0]);
        });
      },
      async edit({ messageId, conversationId, actorId, text, editedAt }) {
        const { rows } = await pool.query(`UPDATE messages SET body=$4,edited_at=$5 WHERE id=$1 AND conversation_id=$2 AND sender_id=$3 AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM conversation_members cm WHERE cm.conversation_id=messages.conversation_id AND cm.user_id=$3) AND NOT EXISTS (SELECT 1 FROM attachments a WHERE a.message_id=messages.id) RETURNING *`, [messageId,conversationId,actorId,text,editedAt]);
        if (rows[0]) return this.getById(messageId);
        const existing = await pool.query('SELECT sender_id,deleted_at FROM messages WHERE id=$1 AND conversation_id=$2', [messageId,conversationId]);
        if (!existing.rows[0] || existing.rows[0].deleted_at) throw Object.assign(new Error('MESSAGE_NOT_FOUND'), { code: 'MESSAGE_NOT_FOUND' });
        if (existing.rows[0].sender_id !== actorId) throw Object.assign(new Error('MESSAGE_FORBIDDEN'), { code: 'MESSAGE_FORBIDDEN' });
        throw Object.assign(new Error('ATTACHMENT_MESSAGE_IMMUTABLE'), { code: 'ATTACHMENT_MESSAGE_IMMUTABLE' });
      },
      async remove({ messageId, conversationId, actorId, deletedAt }) {
        const { rows } = await pool.query(`UPDATE messages SET body=NULL,deleted_at=$4,pinned_at=NULL,pinned_by=NULL WHERE id=$1 AND conversation_id=$2 AND sender_id=$3 AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM conversation_members cm WHERE cm.conversation_id=messages.conversation_id AND cm.user_id=$3) RETURNING *`, [messageId,conversationId,actorId,deletedAt]);
        if (rows[0]) return this.getById(messageId);
        const existing = await pool.query('SELECT sender_id,deleted_at FROM messages WHERE id=$1 AND conversation_id=$2', [messageId,conversationId]);
        if (!existing.rows[0] || existing.rows[0].deleted_at) throw Object.assign(new Error('MESSAGE_NOT_FOUND'), { code: 'MESSAGE_NOT_FOUND' });
        throw Object.assign(new Error('MESSAGE_FORBIDDEN'), { code: 'MESSAGE_FORBIDDEN' });
      },
      async setPinned({ messageId, conversationId, actorId, pinned, updatedAt }) {
        await withTransaction(async client => {
          const c = await client.query('SELECT type FROM conversations WHERE id=$1 AND EXISTS (SELECT 1 FROM conversation_members WHERE conversation_id=$1 AND user_id=$2)', [conversationId,actorId]);
          const m = await client.query('SELECT * FROM messages WHERE id=$1 AND conversation_id=$2 AND deleted_at IS NULL FOR UPDATE', [messageId,conversationId]);
          if (!c.rows[0] || !m.rows[0]) throw Object.assign(new Error('MESSAGE_NOT_FOUND'), { code: 'MESSAGE_NOT_FOUND' });
          if (c.rows[0].type === 'group') {
            const role = await client.query('SELECT role FROM conversation_members WHERE conversation_id=$1 AND user_id=$2', [conversationId,actorId]);
            if (!['owner','admin'].includes(role.rows[0]?.role)) throw Object.assign(new Error('MESSAGE_PIN_FORBIDDEN'), { code: 'MESSAGE_PIN_FORBIDDEN' });
          }
          await client.query('UPDATE messages SET pinned_at=$3,pinned_by=$4 WHERE id=$1 AND conversation_id=$2', [messageId,conversationId,pinned?updatedAt:null,pinned?actorId:null]);
        });
        return this.getById(messageId);
      },
      async markRead({ conversationId, userId, messageId, readAt }) {
        return withTransaction(async client => {
          const membership = await client.query('SELECT 1 FROM conversation_members WHERE conversation_id=$1 AND user_id=$2', [conversationId,userId]);
          if (!membership.rows[0]) throw Object.assign(new Error('MESSAGE_NOT_FOUND'), { code: 'MESSAGE_NOT_FOUND' });
          const target = await client.query('SELECT id,created_at FROM messages WHERE id=$1 AND conversation_id=$2', [messageId,conversationId]);
          if (!target.rows[0]) throw Object.assign(new Error('MESSAGE_NOT_FOUND'), { code: 'MESSAGE_NOT_FOUND' });
          const { rows } = await client.query(`INSERT INTO message_receipts(message_id,user_id,read_at)
            SELECT m.id,$4,$5 FROM messages m WHERE m.conversation_id=$1 AND (m.created_at,m.id) <= ($2,$3) AND m.sender_id <> $4 AND m.deleted_at IS NULL
            ON CONFLICT(message_id,user_id) DO UPDATE SET read_at=EXCLUDED.read_at RETURNING message_id`, [conversationId,target.rows[0].created_at,messageId,userId,readAt]);
          return rows.map(row => row.message_id);
        });
      }
    },
    attachments: {
      async getUsageForUser(userId) { const { rows } = await pool.query("SELECT COALESCE(SUM(size_bytes),0)::bigint AS bytes, COUNT(*)::int AS files FROM attachments WHERE uploader_id=$1 AND status = 'attached'", [userId]); return { bytes: Number(rows[0]?.bytes || 0), files: Number(rows[0]?.files || 0) }; },
      async listForUser(userId) { const { rows } = await pool.query("SELECT id,conversation_id,uploader_id,message_id,filename,detected_mime,size_bytes,storage_path,status,created_at FROM attachments WHERE uploader_id=$1 AND status='attached' ORDER BY created_at DESC,id DESC LIMIT 500", [userId]); return rows.map(r => ({ id:r.id,conversationId:r.conversation_id,messageId:r.message_id,originalName:r.filename,mimeType:r.detected_mime,size:Number(r.size_bytes),createdAt:iso(r.created_at) })); },
      async removeForUser({ attachmentId, userId, deletedAt }) { return withTransaction(async client => { const { rows } = await client.query("SELECT id,conversation_id,uploader_id,message_id,filename,detected_mime,size_bytes,storage_path,status,created_at FROM attachments WHERE id=$1 AND uploader_id=$2 AND status='attached' FOR UPDATE", [attachmentId,userId]); const r=rows[0]; if (!r) return null; if (r.message_id) await client.query("UPDATE messages SET body=NULL,deleted_at=COALESCE(deleted_at,$2),pinned_at=NULL,pinned_by=NULL WHERE id=$1 AND sender_id=$3", [r.message_id,deletedAt,userId]); await client.query("UPDATE attachments SET status='orphaned',message_id=NULL WHERE id=$1", [attachmentId]); return { id:r.id,conversationId:r.conversation_id,uploadedBy:r.uploader_id,messageId:r.message_id,originalName:r.filename,mimeType:r.detected_mime,size:Number(r.size_bytes),storageName:r.storage_path,status:r.status,createdAt:iso(r.created_at) }; }); },
      async getById(attachmentId) {
        const { rows } = await pool.query('SELECT id,conversation_id,uploader_id,filename,detected_mime,size_bytes,storage_path,status,message_id,created_at FROM attachments WHERE id=$1', [attachmentId]);
        const r = rows[0]; return r && ({ id:r.id,conversationId:r.conversation_id,uploadedBy:r.uploader_id,originalName:r.filename,mimeType:r.detected_mime,size:Number(r.size_bytes),storageName:r.storage_path,status:r.status,messageId:r.message_id,createdAt:iso(r.created_at) });
      },
      async createWithMessage(attachment, message) {
        return withTransaction(async client => {
          await client.query('INSERT INTO messages(id,conversation_id,sender_id,body,created_at) VALUES($1,$2,$3,$4,$5)', [message.id,message.conversationId,message.senderId,message.text,message.createdAt]);
          await client.query(`INSERT INTO attachments(id,conversation_id,uploader_id,message_id,status,filename,detected_mime,size_bytes,storage_path,created_at)
            VALUES($1,$2,$3,$4,'attached',$5,$6,$7,$8,$9)`, [attachment.id,attachment.conversationId,attachment.uploadedBy,message.id,attachment.originalName,attachment.mimeType,attachment.size,attachment.storageName,attachment.createdAt]);
          await client.query('UPDATE conversations SET updated_at=$2 WHERE id=$1', [message.conversationId,message.createdAt]);
          return message;
        });
      }
    }
  };
}
module.exports = { createPgStorage };
