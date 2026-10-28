'use strict';
const { Store } = require('../../store');

function createJsonStorage(filePath) {
  const store = new Store(filePath);
  return {
    mode: 'json',
    ping: async () => true,
    init: () => store.init(),
    close: async () => {},
    id: prefix => store.id(prefix),
    publicUser: user => store.publicUser(user),
    users: {
      getById: async id => store.userById(id) || null,
      setLastSeen: async (id, lastSeenAt) => store.mutate(data => { const user = data.users.find(item => item.id === id); if (user) user.lastSeenAt = lastSeenAt; }),
      getByEmail: async email => store.userByEmail(email) || null,
      updateProfile: async (userId, profile) => store.mutate(data => { const user = data.users.find(item => item.id === userId); if (!user) return null; user.name = profile.name; user.updatedAt = profile.updatedAt; return store.publicUser(user); }),
      getAvatar: async userId => { const user = store.userById(userId); return user && user.avatarStorageName ? { storageName: user.avatarStorageName, mimeType: user.avatarMimeType || null } : null; },
      updateAvatar: async (userId, avatar) => store.mutate(data => { const user = data.users.find(item => item.id === userId); if (!user) return null; const previous = user.avatarStorageName ? { storageName: user.avatarStorageName, mimeType: user.avatarMimeType || null } : null; user.avatarStorageName = avatar?.storageName || null; user.avatarMimeType = avatar?.mimeType || null; user.updatedAt = avatar.updatedAt; return { user: store.publicUser(user), previous }; }),
      create: async user => store.mutate(data => {
        if (data.users.some(u => u.email.toLowerCase() === user.email.toLowerCase())) throw Object.assign(new Error('EMAIL_EXISTS'), { code: 'EMAIL_EXISTS' });
        user.privacySettings ||= { showLastSeen: 'everyone', showOnlineStatus: 'everyone', notificationsEnabled: true };
        data.users.push(user); return user;
      }),
      getPrivacy: async userId => { const u = store.userById(userId); return u?.privacySettings || { showLastSeen: 'everyone', showOnlineStatus: 'everyone', notificationsEnabled: true }; },
      setPrivacy: async (userId, settings) => store.mutate(data => { const u = data.users.find(x => x.id === userId); if (!u) return null; u.privacySettings = { ...(u.privacySettings || {}), ...settings }; return u.privacySettings; })
    },
    conversations: {
      isMember: async (conversationId, userId) => store.isMember(conversationId, userId),
      getForMember: async (conversationId, userId) => store.data.conversations.find(c => c.id === conversationId && c.memberIds.includes(userId)) || null,
      listForUser: async userId => store.data.conversations.filter(c => c.memberIds.includes(userId)).map(c => ({
        ...c,
        members: c.memberIds.map(id => store.userById(id)).filter(Boolean).map(store.publicUser),
        lastMessage: store.data.messages.filter(m => m.conversationId === c.id).at(-1) || null
      })),
      createDirect: async ({ title, userId, recipientId, createdAt }) => store.mutate(data => {
        const existing = data.conversations.find(c => c.type !== 'group' && c.memberIds.length === 2 && c.memberIds.includes(userId) && c.memberIds.includes(recipientId));
        if (existing) return { conversation: existing, created: false };
        const conversation = { id: store.id('cnv'), type: 'direct', title, memberIds: [userId, recipientId], memberRoles: { [userId]: 'member', [recipientId]: 'member' }, createdAt, updatedAt: createdAt };
        data.conversations.push(conversation); return { conversation, created: true };
      }),
      createGroup: async ({ title, userId, memberIds, createdAt }) => store.mutate(data => {
        const uniqueMembers = [...new Set([userId, ...memberIds])];
        if (uniqueMembers.length < 2) throw new Error('GROUP_REQUIRES_MEMBERS');
        const memberRoles = Object.fromEntries(uniqueMembers.map(id => [id, id === userId ? 'owner' : 'member']));
        const conversation = { id: store.id('cnv'), type: 'group', title, memberIds: uniqueMembers, memberRoles, createdAt, updatedAt: createdAt };
        data.conversations.push(conversation);
        return { conversation, created: true };
      }),
      getRole: async (conversationId, userId) => {
        const c = store.data.conversations.find(x => x.id === conversationId);
        return c && c.memberIds.includes(userId) ? (c.memberRoles?.[userId] || 'member') : null;
      },
      renameGroup: async ({ conversationId, actorId, title, updatedAt }) => store.mutate(data => {
        const c = data.conversations.find(x => x.id === conversationId && x.type === 'group');
        if (!c) throw Object.assign(new Error('GROUP_NOT_FOUND'), { code: 'GROUP_NOT_FOUND' });
        const role = c.memberRoles?.[actorId] || (c.memberIds.includes(actorId) ? 'member' : null);
        if (!['owner', 'admin'].includes(role)) throw Object.assign(new Error('GROUP_FORBIDDEN'), { code: 'GROUP_FORBIDDEN' });
        c.title = title; c.updatedAt = updatedAt; return c;
      }),
      addGroupMembers: async ({ conversationId, actorId, memberIds, joinedAt, updatedAt }) => store.mutate(data => {
        const c = data.conversations.find(x => x.id === conversationId && x.type === 'group');
        if (!c) throw Object.assign(new Error('GROUP_NOT_FOUND'), { code: 'GROUP_NOT_FOUND' });
        const role = c.memberRoles?.[actorId] || (c.memberIds.includes(actorId) ? 'member' : null);
        if (!['owner', 'admin'].includes(role)) throw Object.assign(new Error('GROUP_FORBIDDEN'), { code: 'GROUP_FORBIDDEN' });
        const incoming = [...new Set(memberIds)].filter(id => !c.memberIds.includes(id));
        if (c.memberIds.length + incoming.length > 100) throw Object.assign(new Error('GROUP_LIMIT'), { code: 'GROUP_LIMIT' });
        for (const id of incoming) { c.memberIds.push(id); c.memberRoles ||= {}; c.memberRoles[id] = 'member'; }
        c.updatedAt = updatedAt; return { conversation: c, added: incoming };
      }),
      setGroupMemberRole: async ({ conversationId, actorId, targetUserId, role, updatedAt }) => store.mutate(data => {
        const c = data.conversations.find(x => x.id === conversationId && x.type === 'group');
        if (!c) throw Object.assign(new Error('GROUP_NOT_FOUND'), { code: 'GROUP_NOT_FOUND' });
        const actorRole = c.memberRoles?.[actorId] || (c.memberIds.includes(actorId) ? 'member' : null);
        const targetRole = c.memberRoles?.[targetUserId] || (c.memberIds.includes(targetUserId) ? 'member' : null);
        if (actorRole !== 'owner') throw Object.assign(new Error('GROUP_OWNER_REQUIRED'), { code: 'GROUP_OWNER_REQUIRED' });
        if (!targetRole || targetRole === 'owner') throw Object.assign(new Error('GROUP_MEMBER_NOT_FOUND'), { code: 'GROUP_MEMBER_NOT_FOUND' });
        c.memberRoles ||= {}; c.memberRoles[targetUserId] = role; c.updatedAt = updatedAt; return c;
      }),
      removeGroupMember: async ({ conversationId, actorId, targetUserId, updatedAt }) => store.mutate(data => {
        const c = data.conversations.find(x => x.id === conversationId && x.type === 'group');
        if (!c) throw Object.assign(new Error('GROUP_NOT_FOUND'), { code: 'GROUP_NOT_FOUND' });
        const actorRole = c.memberRoles?.[actorId] || (c.memberIds.includes(actorId) ? 'member' : null);
        const targetRole = c.memberRoles?.[targetUserId] || (c.memberIds.includes(targetUserId) ? 'member' : null);
        if (!actorRole || !targetRole) throw Object.assign(new Error('GROUP_MEMBER_NOT_FOUND'), { code: 'GROUP_MEMBER_NOT_FOUND' });
        if (targetRole === 'owner') throw Object.assign(new Error('GROUP_OWNER_PROTECTED'), { code: 'GROUP_OWNER_PROTECTED' });
        if (actorRole !== 'owner' && !(actorRole === 'admin' && targetRole === 'member')) throw Object.assign(new Error('GROUP_FORBIDDEN'), { code: 'GROUP_FORBIDDEN' });
        c.memberIds = c.memberIds.filter(id => id !== targetUserId); if (c.memberRoles) delete c.memberRoles[targetUserId];
        c.updatedAt = updatedAt; return c;
      }),
      touch: async (id, updatedAt) => store.mutate(data => { const c = data.conversations.find(x => x.id === id); if (c) c.updatedAt = updatedAt; })
    },
    sessions: {
      create: async session => store.mutate(data => { data.sessions ||= []; data.sessions.push(session); return session; }),
      getById: async sessionId => (store.data.sessions || []).find(s => s.id === sessionId) || null,
      listForUser: async userId => (store.data.sessions || []).filter(s => s.userId === userId && !s.revokedAt && Date.parse(s.expiresAt) > Date.now()).sort((a,b) => b.createdAt.localeCompare(a.createdAt)).map(({id, createdAt, expiresAt, userAgent, ip, lastUsedAt}) => ({id, createdAt, expiresAt, userAgent, ip, lastUsedAt})),
      revoke: async ({ sessionId, userId, revokedAt }) => store.mutate(data => { const s=(data.sessions||[]).find(x=>x.id===sessionId && x.userId===userId && !x.revokedAt); if (!s) return false; s.revokedAt=revokedAt; return true; }),
      revokeAllExcept: async ({ userId, exceptSessionId, revokedAt }) => store.mutate(data => { let count=0; for (const s of data.sessions||[]) if(s.userId===userId && s.id!==exceptSessionId && !s.revokedAt){s.revokedAt=revokedAt;count++;} return count; })
    },
    notifications: {
      createForUsers: async ({ users, conversationId, messageId, senderId, preview, createdAt }) => store.mutate(data => { data.notifications ||= []; const created=[]; for(const userId of [...new Set(users)].filter(id=>id!==senderId)){ const user=data.users.find(u=>u.id===userId); if(user?.privacySettings?.notificationsEnabled===false) continue; const n={id:store.id('ntf'),userId,conversationId,messageId,senderId,preview:String(preview||'رسالة جديدة').slice(0,120),createdAt,readAt:null}; data.notifications.push(n); created.push(n); } return created; }),
      listForUser: async (userId, { limit=50, before }={}) => (store.data.notifications||[]).filter(n=>n.userId===userId && store.isMember(n.conversationId,userId) && (!before || n.createdAt<before)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,limit),
      unreadCount: async userId => (store.data.notifications||[]).filter(n=>n.userId===userId&&store.isMember(n.conversationId,userId)&&!n.readAt).length,
      markRead: async ({ userId, notificationId, readAt }) => store.mutate(data => { const n=(data.notifications||[]).find(x=>x.id===notificationId&&x.userId===userId&&store.isMember(x.conversationId,userId)); if(!n)return null; n.readAt ||= readAt; return n; }),
      markAllRead: async ({ userId, readAt }) => store.mutate(data => { let count=0; for(const n of data.notifications||[]) if(n.userId===userId&&store.isMember(n.conversationId,userId)&&!n.readAt){n.readAt=readAt;count++;} return count; }),
      delete: async ({ userId, notificationId }) => store.mutate(data => { const before=(data.notifications||[]).length; data.notifications=data.notifications.filter(n=>!(n.id===notificationId&&n.userId===userId)); return data.notifications.length<before; })
    },
    messages: {
      getById: async messageId => {
        const m = store.data.messages.find(item => item.id === messageId);
        if (!m) return null;
        return { ...m, deleted: Boolean(m.deletedAt), readBy: (store.data.messageReceipts || []).filter(r => r.messageId === m.id).map(r => r.userId) };
      },
      listForConversation: async (conversationId, { limit = 50, before } = {}) => {
        let rows = store.data.messages.filter(m => m.conversationId === conversationId && (!before || m.createdAt < before));
        return rows.slice(-limit).map(m => ({ ...m, deleted: Boolean(m.deletedAt), readBy: (store.data.messageReceipts || []).filter(r => r.messageId === m.id).map(r => r.userId) }));
      },
      create: async message => store.mutate(data => {
        const conversation = data.conversations.find(c => c.id === message.conversationId && c.memberIds.includes(message.senderId));
        if (!conversation) throw Object.assign(new Error('MESSAGE_NOT_FOUND'), { code: 'MESSAGE_NOT_FOUND' });
        if (message.replyToMessageId && !data.messages.some(m => m.id === message.replyToMessageId && m.conversationId === message.conversationId && !m.deletedAt)) throw Object.assign(new Error('MESSAGE_REFERENCE_INVALID'), { code: 'MESSAGE_REFERENCE_INVALID' });
        if (!Array.isArray(data.messageReceipts)) data.messageReceipts = [];
        const saved = { editedAt: null, deletedAt: null, pinnedAt: null, pinnedBy: null, replyToMessageId: null, forwardedFromMessageId: null, ...message };
        data.messages.push(saved); const c = data.conversations.find(x => x.id === saved.conversationId); if (c) c.updatedAt = saved.createdAt; return saved;
      }),
      edit: async ({ messageId, conversationId, actorId, text, editedAt }) => store.mutate(data => {
        if (!data.conversations.some(c => c.id === conversationId && c.memberIds.includes(actorId))) throw Object.assign(new Error('MESSAGE_NOT_FOUND'), { code: 'MESSAGE_NOT_FOUND' });
        const m = data.messages.find(item => item.id === messageId && item.conversationId === conversationId);
        if (!m || m.deletedAt) throw Object.assign(new Error('MESSAGE_NOT_FOUND'), { code: 'MESSAGE_NOT_FOUND' });
        if (m.senderId !== actorId) throw Object.assign(new Error('MESSAGE_FORBIDDEN'), { code: 'MESSAGE_FORBIDDEN' });
        if (m.attachment) throw Object.assign(new Error('ATTACHMENT_MESSAGE_IMMUTABLE'), { code: 'ATTACHMENT_MESSAGE_IMMUTABLE' });
        m.text = text; m.editedAt = editedAt; return { ...m, deleted: false, readBy: (data.messageReceipts || []).filter(r => r.messageId === m.id).map(r => r.userId) };
      }),
      remove: async ({ messageId, conversationId, actorId, deletedAt }) => store.mutate(data => {
        if (!data.conversations.some(c => c.id === conversationId && c.memberIds.includes(actorId))) throw Object.assign(new Error('MESSAGE_NOT_FOUND'), { code: 'MESSAGE_NOT_FOUND' });
        const m = data.messages.find(item => item.id === messageId && item.conversationId === conversationId);
        if (!m || m.deletedAt) throw Object.assign(new Error('MESSAGE_NOT_FOUND'), { code: 'MESSAGE_NOT_FOUND' });
        if (m.senderId !== actorId) throw Object.assign(new Error('MESSAGE_FORBIDDEN'), { code: 'MESSAGE_FORBIDDEN' });
        m.text = ''; m.deletedAt = deletedAt; m.deleted = true; m.pinnedAt = null; m.pinnedBy = null;
        return { ...m, readBy: (data.messageReceipts || []).filter(r => r.messageId === m.id).map(r => r.userId) };
      }),
      setPinned: async ({ messageId, conversationId, actorId, pinned, updatedAt }) => store.mutate(data => {
        const c = data.conversations.find(item => item.id === conversationId && item.memberIds.includes(actorId));
        const m = data.messages.find(item => item.id === messageId && item.conversationId === conversationId && !item.deletedAt);
        if (!c || !m) throw Object.assign(new Error('MESSAGE_NOT_FOUND'), { code: 'MESSAGE_NOT_FOUND' });
        const role = c.memberRoles?.[actorId] || 'member';
        if (c.type === 'group' && !['owner', 'admin'].includes(role)) throw Object.assign(new Error('MESSAGE_PIN_FORBIDDEN'), { code: 'MESSAGE_PIN_FORBIDDEN' });
        m.pinnedAt = pinned ? updatedAt : null; m.pinnedBy = pinned ? actorId : null;
        return { ...m, deleted: false, readBy: (data.messageReceipts || []).filter(r => r.messageId === m.id).map(r => r.userId) };
      }),
      markRead: async ({ conversationId, userId, messageId, readAt }) => store.mutate(data => {
        if (!data.conversations.some(c => c.id === conversationId && c.memberIds.includes(userId))) throw Object.assign(new Error('MESSAGE_NOT_FOUND'), { code: 'MESSAGE_NOT_FOUND' });
        const target = data.messages.find(m => m.id === messageId && m.conversationId === conversationId);
        if (!target) throw Object.assign(new Error('MESSAGE_NOT_FOUND'), { code: 'MESSAGE_NOT_FOUND' });
        if (!Array.isArray(data.messageReceipts)) data.messageReceipts = [];
        const ids = data.messages.filter(m => m.conversationId === conversationId && (m.createdAt < target.createdAt || (m.createdAt === target.createdAt && m.id <= target.id)) && m.senderId !== userId && !m.deletedAt).map(m => m.id);
        for (const id of ids) { const old = data.messageReceipts.find(r => r.messageId === id && r.userId === userId); if (old) old.readAt = readAt; else data.messageReceipts.push({ messageId: id, userId, readAt }); }
        return ids;
      })
    },
    attachments: {
      getById: async id => store.data.attachments.find(a => a.id === id) || null,
      listForUser: async userId => (store.data.attachments || []).filter(a => a.uploadedBy === userId && a.status !== 'orphaned').sort((a,b) => String(b.createdAt).localeCompare(String(a.createdAt))).map(a => ({ id:a.id, conversationId:a.conversationId, messageId:a.messageId || null, originalName:a.originalName, mimeType:a.mimeType, size:Number(a.size)||0, createdAt:a.createdAt })),
      removeForUser: async ({ attachmentId, userId, deletedAt }) => store.mutate(data => {
        const item = (data.attachments || []).find(a => a.id === attachmentId && a.uploadedBy === userId && a.status !== 'orphaned');
        if (!item) return null;
        const removed = { ...item };
        const message = data.messages.find(m => m.id === item.messageId && m.conversationId === item.conversationId);
        if (message && !message.deletedAt) { message.text = ''; message.deletedAt = deletedAt; message.pinnedAt = null; message.pinnedBy = null; }
        item.status = 'orphaned'; item.messageId = null;
        return removed;
      }),
      getUsageForUser: async userId => { const items = (store.data.attachments || []).filter(a => a.uploadedBy === userId && a.status !== 'orphaned'); return { bytes: items.reduce((sum, a) => sum + Math.max(0, Number(a.size) || 0), 0), files: items.length }; },
      createWithMessage: async (attachment, message) => store.mutate(data => {
        if (!Array.isArray(data.attachments)) data.attachments = [];
        attachment.messageId ||= message.id; attachment.status ||= 'attached'; data.attachments.push(attachment); data.messages.push(message);
        const c = data.conversations.find(x => x.id === message.conversationId); if (c) c.updatedAt = message.createdAt;
        return message;
      })
    }
  };
}
module.exports = { createJsonStorage };
