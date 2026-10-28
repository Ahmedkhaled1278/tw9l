const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

class Store {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = { users: [], conversations: [], messages: [], attachments: [], messageReceipts: [], sessions: [], notifications: [] };
    this.writeQueue = Promise.resolve();
  }

  async init() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      for (const key of ['users', 'conversations', 'messages']) {
        if (!Array.isArray(parsed[key])) throw new Error(`Invalid store field: ${key}`);
      }
      this.data = { ...parsed, attachments: Array.isArray(parsed.attachments) ? parsed.attachments : [], messageReceipts: Array.isArray(parsed.messageReceipts) ? parsed.messageReceipts : [], sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [], notifications: Array.isArray(parsed.notifications) ? parsed.notifications : [] };
      for (const user of this.data.users) { user.lastSeenAt ||= null; user.privacySettings ||= { showLastSeen: 'everyone', showOnlineStatus: 'everyone', notificationsEnabled: true }; }
      for (const message of this.data.messages) { message.editedAt ||= null; message.deletedAt ||= null; message.pinnedAt ||= null; message.pinnedBy ||= null; message.replyToMessageId ||= null; message.forwardedFromMessageId ||= null; }
      for (const attachment of this.data.attachments) {
        attachment.status ||= 'attached';
        if (!attachment.messageId) attachment.messageId = this.data.messages.find(message => message.attachment?.id === attachment.id)?.id || null;
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw new Error(`Cannot load data store safely: ${err.message}`);
      await this.persist();
    }
  }

  id(prefix) { return `${prefix}_${crypto.randomUUID()}`; }

  async persist() {
    const snapshot = JSON.stringify(this.data, null, 2);
    const temp = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(temp, snapshot, { mode: 0o600 });
    await fs.rename(temp, this.filePath);
  }

  async mutate(fn) {
    const run = this.writeQueue.then(async () => {
      const result = await fn(this.data);
      await this.persist();
      return result;
    });
    this.writeQueue = run.catch(() => {});
    return run;
  }

  userByEmail(email) { return this.data.users.find(u => u.email === email); }
  userById(id) { return this.data.users.find(u => u.id === id); }
  publicUser(user) {
    return user && { id: user.id, name: user.name, email: user.email, createdAt: user.createdAt, lastSeenAt: user.lastSeenAt || null, avatarUrl: user.avatarStorageName ? `/api/account/avatar/${encodeURIComponent(user.id)}` : null };
  }
  isMember(conversationId, userId) {
    const c = this.data.conversations.find(x => x.id === conversationId);
    return !!c && c.memberIds.includes(userId);
  }
}

module.exports = { Store };