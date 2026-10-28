'use strict';
require('dotenv').config();
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');
const { createStorage } = require('./storage');
const { createPresenceRegistry } = require('./realtime/presence');

const app = express();
const server = http.createServer(app);
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
const jwtSecret = process.env.JWT_SECRET || '';
const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:3000,http://127.0.0.1:3000,http://localhost:8080').split(',').map(x => x.trim()).filter(Boolean);
const uploadDir = path.resolve(process.env.UPLOAD_DIR || './uploads');
const maxUploadBytes = Math.max(1, Number(process.env.MAX_UPLOAD_MB || 5)) * 1024 * 1024;
const accountStorageQuotaBytes = Math.max(10, Number(process.env.ACCOUNT_STORAGE_QUOTA_MB || 100)) * 1024 * 1024;
const storage = createStorage();
const presence = createPresenceRegistry();
const io = new Server(server, { cors: { origin: allowedOrigins, methods: ['GET', 'POST', 'PATCH', 'DELETE'] } });
const now = () => new Date().toISOString();
const cleanName = value => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, 40) : '';
const cleanEmail = value => typeof value === 'string' ? value.trim().toLowerCase().slice(0, 254) : '';
const publicUser = user => storage.publicUser(user);

if (jwtSecret.length < 32) {
  console.error('Startup blocked: JWT_SECRET must be at least 32 characters. Set a random secret in .env.');
  process.exit(1);
}
app.disable('x-powered-by');
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({
  origin(origin, callback) { if (!origin || allowedOrigins.includes(origin)) return callback(null, true); return callback(new Error('Origin not allowed by CORS')); },
  methods: ['GET', 'POST', 'PATCH', 'DELETE'], allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.resolve(__dirname, '../website'), { extensions: ['html'] }));
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false }));
app.use('/api', rateLimit({ windowMs: 60 * 1000, limit: 180, standardHeaders: 'draft-7', legacyHeaders: false }));

async function signToken(user, req) {
  const createdAt = now();
  const sessionId = storage.id('ses');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  await storage.sessions.create({ id: sessionId, userId: user.id, createdAt, expiresAt, userAgent: String(req?.headers?.['user-agent'] || '').slice(0, 300) || null, ip: String(req?.ip || '').slice(0, 64) || null });
  return jwt.sign({ sub: user.id, jti: sessionId }, jwtSecret, { expiresIn: '7d', issuer: 'wasl-api', audience: 'wasl-client' });
}
async function authFromToken(token) {
  const payload = jwt.verify(token, jwtSecret, { issuer: 'wasl-api', audience: 'wasl-client' });
  if (typeof payload.jti !== 'string' || !payload.jti) throw new Error('Session missing');
  const [user, session] = await Promise.all([storage.users.getById(payload.sub), storage.sessions.getById(payload.jti)]);
  if (!user || !session || session.userId !== user.id || session.revokedAt || Date.parse(session.expiresAt) <= Date.now()) throw new Error('Session revoked or expired');
  return { ...user, sessionId: session.id };
}
async function auth(req, res, next) {
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  if (!match) return res.status(401).json({ error: 'يجب تسجيل الدخول أولًا.' });
  try { req.user = await authFromToken(match[1]); return next(); }
  catch { return res.status(401).json({ error: 'جلسة الدخول غير صالحة أو انتهت.' }); }
}
function validateMessage(text) { return typeof text === 'string' && text.trim().length > 0 && text.length <= 2000; }
function validId(value) { return typeof value === 'string' && value.length >= 3 && value.length <= 160 && /^[A-Za-z0-9_-]+$/.test(value); }
async function memberConversation(id, userId) { return storage.conversations.getForMember(id, userId); }
function publicAttachment(a) { return { id: a.id, originalName: a.originalName, mimeType: a.mimeType, size: a.size }; }
function emitConversationEventToUsers(conversation, eventName, payload) {
  if (!conversation || !Array.isArray(conversation.memberIds)) return;
  for (const userId of conversation.memberIds) io.to(`user:${userId}`).emit(eventName, payload);
}
async function emitMessageNotifications(conversation, message) {
  if (!conversation || !Array.isArray(conversation.memberIds)) return;
  // User rooms cover other devices even when the conversation is not currently open.
  emitConversationEventToUsers(conversation, 'message:sync', message);
  const preview = message.deleted ? 'تم حذف رسالة' : (message.text || (message.attachment ? 'أرسل ملفًا مرفقًا' : 'رسالة جديدة')).slice(0, 120);
  try {
    const notifications = await storage.notifications.createForUsers({ users: conversation.memberIds, conversationId: conversation.id, messageId: message.id, senderId: message.senderId, preview, createdAt: message.createdAt });
    for (const notification of notifications) io.to(`user:${notification.userId}`).emit('notification:new', { ...notification, unreadCount: await storage.notifications.unreadCount(notification.userId) });
  } catch (err) { console.error('Could not persist message notifications:', err.message); }
}

app.get('/api/health', async (_req, res) => {
  try { await storage.ping(); res.json({ status: 'ok', service: 'wasl-api', storage: storage.mode, time: now() }); }
  catch { res.status(503).json({ status: 'error', service: 'wasl-api' }); }
});
app.post('/api/auth/register', async (req, res, next) => {
  try {
    const name = cleanName(req.body?.name), email = cleanEmail(req.body?.email), password = req.body?.password;
    if (name.length < 2) return res.status(400).json({ error: 'الاسم يجب أن يتكون من حرفين على الأقل.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'البريد الإلكتروني غير صالح.' });
    if (typeof password !== 'string' || password.length < 10 || password.length > 72) return res.status(400).json({ error: 'كلمة المرور يجب أن تكون بين 10 و72 حرفًا.' });
    const passwordHash = await bcrypt.hash(password, 12);
    const user = await storage.users.create({ id: storage.id('usr'), name, email, passwordHash, createdAt: now() });
    return res.status(201).json({ user: publicUser(user), token: await signToken(user, req) });
  } catch (err) { if (err.code === 'EMAIL_EXISTS' || err.code === '23505') return res.status(409).json({ error: 'هذا البريد مسجل بالفعل.' }); next(err); }
});
app.post('/api/auth/login', async (req, res, next) => {
  try {
    const email = cleanEmail(req.body?.email), password = req.body?.password;
    const user = await storage.users.getByEmail(email);
    const ok = user && typeof password === 'string' && await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ error: 'البريد الإلكتروني أو كلمة المرور غير صحيحة.' });
    return res.json({ user: publicUser(user), token: await signToken(user, req) });
  } catch (err) { next(err); }
});
app.get('/api/auth/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));
app.patch('/api/account/profile', auth, async (req, res, next) => {
  try {
    const rawName = typeof req.body?.name === 'string' ? req.body.name.trim().replace(/\s+/g, ' ') : '';
    if (rawName.length > 40) return res.status(400).json({ error: 'الاسم لا يمكن أن يتجاوز 40 حرفًا.' });
    const name = cleanName(rawName);
    if (name.length < 2) return res.status(400).json({ error: 'الاسم يجب أن يتكون من حرفين على الأقل.' });
    const user = await storage.users.updateProfile(req.user.id, { name, updatedAt: now() });
    if (!user) return res.status(404).json({ error: 'الحساب غير موجود.' });
    return res.json({ user: publicUser(user) });
  } catch (err) { next(err); }
});
const avatarDir = path.resolve(uploadDir, 'profile-avatars');
const avatarUpload = multer({
  storage: multer.diskStorage({
    destination: async (_req, _file, cb) => { try { await fs.mkdir(avatarDir, { recursive: true }); cb(null, avatarDir); } catch (err) { cb(err); } },
    filename: (_req, _file, cb) => cb(null, `${crypto.randomUUID()}.avatar`)
  }),
  limits: { fileSize: 1024 * 1024, files: 1, fields: 0 },
  fileFilter: (_req, file, cb) => ['image/jpeg','image/png','image/webp'].includes(file.mimetype)
    ? cb(null, true) : cb(Object.assign(new Error('صورة الحساب لازم تكون PNG أو JPEG أو WebP.'), { status: 415 }))
});
async function validAvatarSignature(file) {
  const handle = await fs.open(file.path, 'r');
  try {
    const b = Buffer.alloc(16); const { bytesRead } = await handle.read(b, 0, b.length, 0); const head = b.subarray(0, bytesRead);
    if (file.mimetype === 'image/jpeg') return head.length >= 3 && head[0]===0xff && head[1]===0xd8 && head[2]===0xff;
    if (file.mimetype === 'image/png') return head.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    if (file.mimetype === 'image/webp') return head.toString('ascii',0,4)==='RIFF' && head.toString('ascii',8,12)==='WEBP';
    return false;
  } finally { await handle.close(); }
}
app.post('/api/account/avatar', auth, avatarUpload.single('avatar'), async (req, res, next) => {
  let tempPath = req.file?.path;
  try {
    if (!req.file) return res.status(400).json({ error: 'اختار صورة للحساب أولًا.' });
    if (!(await validAvatarSignature(req.file))) { await fs.unlink(tempPath).catch(() => {}); tempPath = null; return res.status(415).json({ error: 'محتوى الصورة لا يطابق نوع الملف.' }); }
    const result = await storage.users.updateAvatar(req.user.id, { storageName: path.basename(req.file.filename), mimeType: req.file.mimetype, updatedAt: now() });
    if (!result) { await fs.unlink(tempPath).catch(() => {}); tempPath = null; return res.status(404).json({ error: 'الحساب غير موجود.' }); }
    tempPath = null;
    if (result.previous?.storageName && result.previous.storageName !== path.basename(req.file.filename)) await fs.unlink(path.join(avatarDir, path.basename(result.previous.storageName))).catch(() => {});
    return res.status(201).json({ user: result.user });
  } catch (err) { if (tempPath) await fs.unlink(tempPath).catch(() => {}); return next(err); }
});
app.delete('/api/account/avatar', auth, async (req, res, next) => {
  try {
    const result = await storage.users.updateAvatar(req.user.id, { storageName: null, mimeType: null, updatedAt: now() });
    if (!result) return res.status(404).json({ error: 'الحساب غير موجود.' });
    if (result.previous?.storageName) await fs.unlink(path.join(avatarDir, path.basename(result.previous.storageName))).catch(() => {});
    return res.json({ user: result.user });
  } catch (err) { return next(err); }
});
app.get('/api/account/avatar/:userId', auth, async (req, res, next) => {
  try {
    const avatar = await storage.users.getAvatar(req.params.userId);
    if (!avatar || !/^[0-9a-f-]+\.avatar$/i.test(avatar.storageName) || !['image/jpeg','image/png','image/webp'].includes(avatar.mimeType)) return res.status(404).json({ error: 'صورة الحساب غير موجودة.' });
    const filePath = path.resolve(avatarDir, avatar.storageName);
    if (path.dirname(filePath) !== avatarDir) return res.status(404).json({ error: 'صورة الحساب غير موجودة.' });
    res.set({ 'Content-Type': avatar.mimeType || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store', 'Content-Security-Policy': "default-src 'none'; sandbox" });
    return res.sendFile(filePath, err => { if (err && !res.headersSent) res.status(err.statusCode === 404 ? 404 : 500).end(); });
  } catch (err) { return next(err); }
});
app.get('/api/account/storage/files', auth, async (req, res, next) => {
  try { const files = await storage.attachments.listForUser(req.user.id); return res.json({ files }); }
  catch (err) { return next(err); }
});
app.delete('/api/account/storage/files/:attachmentId', auth, async (req, res, next) => {
  try {
    if (!validId(req.params.attachmentId)) return res.status(400).json({ error: 'معرّف الملف غير صالح.' });
    const removed = await storage.attachments.removeForUser({ attachmentId: req.params.attachmentId, userId: req.user.id, deletedAt: now() });
    if (!removed) return res.status(404).json({ error: 'الملف غير موجود أو لا تملك صلاحية حذفه.' });
    if (typeof removed.storageName === 'string' && path.basename(removed.storageName) === removed.storageName && !removed.storageName.includes('\\')) {
      const filePath = path.resolve(uploadDir, removed.storageName);
      if (path.dirname(filePath) === uploadDir) await fs.unlink(filePath).catch(() => {});
    }
    const deletedMessage = { id: removed.messageId, conversationId: removed.conversationId, deleted: true, text: '', deletedAt: now() };
    if (removed.messageId) { io.to(`conversation:${removed.conversationId}`).emit('message:deleted', deletedMessage); const conversation = await memberConversation(removed.conversationId, req.user.id); if (conversation) emitConversationEventToUsers(conversation, 'message:deleted', deletedMessage); }
    return res.json({ deleted: true, id: removed.id });
  } catch (err) { return next(err); }
});
app.get('/api/account/storage', auth, async (req, res, next) => {
  try {
    const usage = await storage.attachments.getUsageForUser(req.user.id);
    const avatar = await storage.users.getAvatar(req.user.id);
    let avatarBytes = 0;
    if (avatar?.storageName && /^[0-9a-f-]+\.avatar$/i.test(avatar.storageName)) {
      try { const stat = await fs.stat(path.resolve(avatarDir, path.basename(avatar.storageName))); if (stat.isFile()) avatarBytes = stat.size; } catch {}
    }
    const attachmentBytes = Math.max(0, Number(usage.bytes) || 0);
    const usedBytes = attachmentBytes + avatarBytes;
    return res.json({ usedBytes, attachmentBytes, avatarBytes, files: Math.max(0, Number(usage.files) || 0), quotaBytes: accountStorageQuotaBytes, remainingBytes: Math.max(0, accountStorageQuotaBytes - usedBytes), usagePercent: Math.min(100, Math.round(usedBytes / accountStorageQuotaBytes * 100)) });
  } catch (err) { return next(err); }
});

app.get('/api/auth/sessions', auth, async (req, res, next) => {
  try { const sessions = await storage.sessions.listForUser(req.user.id); return res.json({ sessions: sessions.map(s => ({ ...s, current: s.id === req.user.sessionId })) }); } catch (err) { next(err); }
});
app.delete('/api/auth/sessions/:sessionId', auth, async (req, res, next) => {
  try {
    const target = await storage.sessions.getById(req.params.sessionId);
    if (!target || target.userId !== req.user.id || target.revokedAt) return res.status(404).json({ error: 'الجلسة غير موجودة أو تم إلغاؤها.' });
    const revoked = await storage.sessions.revoke({ sessionId: target.id, userId: req.user.id, revokedAt: now() });
    if (revoked) io.in(`session:${target.id}`).disconnectSockets(true);
    return res.json({ revoked });
  } catch (err) { next(err); }
});
app.post('/api/auth/sessions/revoke-others', auth, async (req, res, next) => {
  try { const count = await storage.sessions.revokeAllExcept({ userId: req.user.id, exceptSessionId: req.user.sessionId, revokedAt: now() }); io.in(`user:${req.user.id}`).fetchSockets().then(sockets => sockets.filter(sock => sock.data.sessionId !== req.user.sessionId).forEach(sock => sock.disconnect(true))).catch(() => {}); return res.json({ revokedCount: count }); } catch (err) { next(err); }
});
app.post('/api/auth/logout', auth, async (req, res, next) => {
  try { await storage.sessions.revoke({ sessionId: req.user.sessionId, userId: req.user.id, revokedAt: now() }); io.in(`session:${req.user.sessionId}`).disconnectSockets(true); return res.json({ loggedOut: true }); } catch (err) { next(err); }
});

const privacyDefaults = { showLastSeen: 'everyone', showOnlineStatus: 'everyone', notificationsEnabled: true };
app.get('/api/account/privacy', auth, async (req, res, next) => {
  try { return res.json({ settings: { ...privacyDefaults, ...(await storage.users.getPrivacy(req.user.id)) } }); } catch (err) { next(err); }
});
app.patch('/api/account/privacy', auth, async (req, res, next) => {
  try {
    const body = req.body || {}, updates = {};
    for (const key of ['showLastSeen', 'showOnlineStatus']) { if (Object.hasOwn(body, key)) { if (!['everyone','contacts','nobody'].includes(body[key])) return res.status(400).json({ error: `قيمة ${key} غير صالحة.` }); updates[key] = body[key]; } }
    if (Object.hasOwn(body, 'notificationsEnabled')) { if (typeof body.notificationsEnabled !== 'boolean') return res.status(400).json({ error: 'notificationsEnabled يجب أن تكون قيمة منطقية.' }); updates.notificationsEnabled = body.notificationsEnabled; }
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'لم يتم إرسال إعدادات خصوصية صالحة للتحديث.' });
    const settings = { ...privacyDefaults, ...(await storage.users.setPrivacy(req.user.id, updates)) };
    const currentPresence = presence.snapshot([req.user.id])[req.user.id];
    const conversations = await storage.conversations.listForUser(req.user.id);
    const peers = new Set(conversations.flatMap(c => c.memberIds || []).filter(id => id !== req.user.id));
    const visibleState = { userId: req.user.id, online: settings.showOnlineStatus === 'nobody' ? false : currentPresence.online, lastSeenAt: settings.showLastSeen === 'nobody' ? null : currentPresence.lastSeenAt };
    for (const peerId of peers) io.to(`user:${peerId}`).emit('presence:update', visibleState);
    return res.json({ settings });
  } catch (err) { next(err); }
});
app.get('/api/notifications', auth, async (req, res, next) => {
  try { const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 50)); const before = typeof req.query.before === 'string' ? req.query.before : undefined; const [notifications, unreadCount] = await Promise.all([storage.notifications.listForUser(req.user.id, { limit, before }), storage.notifications.unreadCount(req.user.id)]); return res.json({ notifications, unreadCount }); } catch (err) { next(err); }
});
app.patch('/api/notifications/:id/read', auth, async (req, res, next) => {
  try { const notification = await storage.notifications.markRead({ userId: req.user.id, notificationId: req.params.id, readAt: now() }); if (!notification) return res.status(404).json({ error: 'الإشعار غير موجود.' }); const unreadCount = await storage.notifications.unreadCount(req.user.id); io.to(`user:${req.user.id}`).emit('notification:read', { notificationId: notification.id, readAt: notification.readAt, unreadCount }); return res.json({ notification, unreadCount }); } catch (err) { next(err); }
});
app.post('/api/notifications/read-all', auth, async (req, res, next) => {
  try { const markedCount = await storage.notifications.markAllRead({ userId: req.user.id, readAt: now() }); io.to(`user:${req.user.id}`).emit('notifications:read-all', { markedCount, unreadCount: 0 }); return res.json({ markedCount, unreadCount: 0 }); } catch (err) { next(err); }
});
app.delete('/api/notifications/:id', auth, async (req, res, next) => {
  try { const deleted = await storage.notifications.delete({ userId: req.user.id, notificationId: req.params.id }); if (!deleted) return res.status(404).json({ error: 'الإشعار غير موجود.' }); const unreadCount = await storage.notifications.unreadCount(req.user.id); io.to(`user:${req.user.id}`).emit('notification:deleted', { notificationId: req.params.id, unreadCount }); return res.json({ deleted: true, unreadCount }); } catch (err) { next(err); }
});

app.post('/api/groups', auth, async (req, res, next) => {
  try {
    const title = cleanName(req.body?.title);
    const rawEmails = req.body?.memberEmails;
    if (title.length < 2) return res.status(400).json({ error: 'اسم المجموعة يجب أن يتكون من حرفين على الأقل.' });
    if (!Array.isArray(rawEmails) || rawEmails.length < 1 || rawEmails.length > 99) {
      return res.status(400).json({ error: 'أضف بريدًا إلكترونيًا واحدًا على الأقل، وبحد أقصى 99 عضوًا بالإضافة إليك.' });
    }
    const emails = [...new Set(rawEmails.map(cleanEmail))];
    if (emails.some(email => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
      return res.status(400).json({ error: 'قائمة البريد الإلكتروني تحتوي على عنوان غير صالح.' });
    }
    if (emails.includes(req.user.email.toLowerCase())) return res.status(400).json({ error: 'لا تضف بريدك إلى القائمة؛ ستتم إضافتك تلقائيًا.' });
    const members = await Promise.all(emails.map(email => storage.users.getByEmail(email)));
    if (members.some(member => !member)) return res.status(404).json({ error: 'تعذر إنشاء المجموعة: تأكد أن كل الأعضاء لديهم حسابات مسجلة.' });
    const result = await storage.conversations.createGroup({
      title, userId: req.user.id, memberIds: members.map(member => member.id), createdAt: now()
    });
    return res.status(201).json({ conversation: result.conversation, created: true });
  } catch (err) { next(err); }
});

app.patch('/api/groups/:id', auth, async (req, res, next) => {
  try {
    const title = cleanName(req.body?.title);
    if (title.length < 2) return res.status(400).json({ error: 'اسم المجموعة يجب أن يتكون من حرفين على الأقل.' });
    const conversation = await storage.conversations.renameGroup({ conversationId: req.params.id, actorId: req.user.id, title, updatedAt: now() });
    io.to(`conversation:${conversation.id}`).emit('group:updated', { conversationId: conversation.id, title: conversation.title });
    return res.json({ conversation });
  } catch (err) { next(err); }
});
app.post('/api/groups/:id/members', auth, async (req, res, next) => {
  try {
    const rawEmails = req.body?.memberEmails;
    if (!Array.isArray(rawEmails) || rawEmails.length < 1 || rawEmails.length > 99) return res.status(400).json({ error: 'أضف بريدًا واحدًا على الأقل وبحد أقصى 99 بريدًا.' });
    const emails = [...new Set(rawEmails.map(cleanEmail))];
    if (emails.some(email => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) return res.status(400).json({ error: 'قائمة البريد الإلكتروني تحتوي على عنوان غير صالح.' });
    const users = await Promise.all(emails.map(email => storage.users.getByEmail(email)));
    if (users.some(user => !user)) return res.status(404).json({ error: 'تأكد أن كل الأعضاء لديهم حسابات مسجلة.' });
    const result = await storage.conversations.addGroupMembers({ conversationId: req.params.id, actorId: req.user.id, memberIds: users.map(user => user.id), joinedAt: now(), updatedAt: now() });
    io.to(`conversation:${result.conversation.id}`).emit('group:updated', { conversationId: result.conversation.id, memberIds: result.conversation.memberIds });
    return res.json({ conversation: result.conversation, addedCount: result.added.length });
  } catch (err) { next(err); }
});
app.patch('/api/groups/:id/members/:userId/role', auth, async (req, res, next) => {
  try {
    const role = req.body?.role;
    if (!['admin', 'member'].includes(role)) return res.status(400).json({ error: 'الدور يجب أن يكون admin أو member.' });
    const conversation = await storage.conversations.setGroupMemberRole({ conversationId: req.params.id, actorId: req.user.id, targetUserId: req.params.userId, role, updatedAt: now() });
    io.to(`conversation:${conversation.id}`).emit('group:updated', { conversationId: conversation.id, memberIds: conversation.memberIds, memberRoles: conversation.memberRoles });
    return res.json({ conversation });
  } catch (err) { next(err); }
});
app.delete('/api/groups/:id/members/:userId', auth, async (req, res, next) => {
  try {
    const conversation = await storage.conversations.removeGroupMember({ conversationId: req.params.id, actorId: req.user.id, targetUserId: req.params.userId, updatedAt: now() });
    io.to(`conversation:${conversation.id}`).emit('group:updated', { conversationId: conversation.id, memberIds: conversation.memberIds });
    io.in(`user:${req.params.userId}`).socketsLeave(`conversation:${conversation.id}`);
    return res.json({ conversation });
  } catch (err) { next(err); }
});

app.get('/api/conversations', auth, async (req, res, next) => {
  try {
    const conversations = await storage.conversations.listForUser(req.user.id);
    const privacyByUser = new Map();
    for (const member of conversations.flatMap(c => c.members || [])) if (!privacyByUser.has(member.id)) privacyByUser.set(member.id, { ...privacyDefaults, ...(await storage.users.getPrivacy(member.id)) });
    for (const conversation of conversations) for (const member of conversation.members || []) {
      if (privacyByUser.get(member.id)?.showLastSeen === 'nobody') member.lastSeenAt = null;
    }
    return res.json({ conversations });
  } catch (err) { next(err); }
});
app.post('/api/conversations', auth, async (req, res, next) => {
  try {
    const title = cleanName(req.body?.title), recipientEmail = cleanEmail(req.body?.recipientEmail);
    if (!recipientEmail) return res.status(400).json({ error: 'أدخل البريد الإلكتروني للشخص الذي تريد مراسلته.' });
    const recipient = await storage.users.getByEmail(recipientEmail);
    if (!recipient) return res.status(404).json({ error: 'لم نعثر على مستخدم بهذا البريد.' });
    if (recipient.id === req.user.id) return res.status(400).json({ error: 'لا يمكنك بدء محادثة مع حسابك نفسه.' });
    const result = await storage.conversations.createDirect({ title: title || 'محادثة مباشرة', userId: req.user.id, recipientId: recipient.id, createdAt: now() });
    return res.status(result.created ? 201 : 200).json({ conversation: result.conversation, created: result.created });
  } catch (err) { next(err); }
});
app.get('/api/conversations/:id/messages', auth, async (req, res, next) => {
  try {
    if (!(await memberConversation(req.params.id, req.user.id))) return res.status(404).json({ error: 'المحادثة غير موجودة.' });
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
    const before = typeof req.query.before === 'string' ? req.query.before : undefined;
    return res.json({ messages: await storage.messages.listForConversation(req.params.id, { limit, before }) });
  } catch (err) { next(err); }
});
app.post('/api/conversations/:id/messages', auth, async (req, res, next) => {
  try {
    const conversation = await memberConversation(req.params.id, req.user.id);
    if (!conversation) return res.status(404).json({ error: 'المحادثة غير موجودة.' });
    const text = req.body?.text;
    if (!validateMessage(text)) return res.status(400).json({ error: 'الرسالة فارغة أو أطول من 2000 حرف.' });
    const replyToMessageId = req.body?.replyToMessageId || null;
    const forwardedFromMessageId = req.body?.forwardedFromMessageId || null;
    if ((replyToMessageId && !validId(replyToMessageId)) || (forwardedFromMessageId && !validId(forwardedFromMessageId))) return res.status(400).json({ error: 'مرجع الرسالة غير صالح.' });
    if (forwardedFromMessageId) {
      const source = await storage.messages.getById(forwardedFromMessageId);
      if (!source || source.deleted || !(await storage.conversations.isMember(source.conversationId, req.user.id))) return res.status(404).json({ error: 'الرسالة المراد إعادة توجيهها غير موجودة.' });
    }
    const message = { id: storage.id('msg'), conversationId: conversation.id, senderId: req.user.id, text: text.trim(), attachment: null, createdAt: now(), replyToMessageId, forwardedFromMessageId };
    const saved = await storage.messages.create(message);
    io.to(`conversation:${conversation.id}`).emit('message:new', saved);
    emitMessageNotifications(conversation, saved);
    return res.status(201).json({ message: saved });
  } catch (err) { next(err); }
});

app.patch('/api/conversations/:id/messages/:messageId', auth, async (req, res, next) => {
  try {
    if (!(await memberConversation(req.params.id, req.user.id))) return res.status(404).json({ error: 'المحادثة غير موجودة.' });
    if (!validId(req.params.messageId)) return res.status(400).json({ error: 'معرّف الرسالة غير صالح.' });
    if (!validateMessage(req.body?.text)) return res.status(400).json({ error: 'الرسالة فارغة أو أطول من 2000 حرف.' });
    const message = await storage.messages.edit({ messageId: req.params.messageId, conversationId: req.params.id, actorId: req.user.id, text: req.body.text.trim(), editedAt: now() });
    io.to(`conversation:${req.params.id}`).emit('message:updated', message);
    const conversation = await memberConversation(req.params.id, req.user.id); emitConversationEventToUsers(conversation, 'message:updated', message);
    return res.json({ message });
  } catch (err) { next(err); }
});
app.delete('/api/conversations/:id/messages/:messageId', auth, async (req, res, next) => {
  try {
    if (!(await memberConversation(req.params.id, req.user.id))) return res.status(404).json({ error: 'المحادثة غير موجودة.' });
    if (!validId(req.params.messageId)) return res.status(400).json({ error: 'معرّف الرسالة غير صالح.' });
    const message = await storage.messages.remove({ messageId: req.params.messageId, conversationId: req.params.id, actorId: req.user.id, deletedAt: now() });
    io.to(`conversation:${req.params.id}`).emit('message:deleted', message);
    const conversation = await memberConversation(req.params.id, req.user.id); emitConversationEventToUsers(conversation, 'message:deleted', message);
    return res.json({ message });
  } catch (err) { next(err); }
});
app.patch('/api/conversations/:id/messages/:messageId/pin', auth, async (req, res, next) => {
  try {
    if (!(await memberConversation(req.params.id, req.user.id))) return res.status(404).json({ error: 'المحادثة غير موجودة.' });
    if (!validId(req.params.messageId) || typeof req.body?.pinned !== 'boolean') return res.status(400).json({ error: 'طلب تثبيت الرسالة غير صالح.' });
    const message = await storage.messages.setPinned({ messageId: req.params.messageId, conversationId: req.params.id, actorId: req.user.id, pinned: req.body.pinned, updatedAt: now() });
    io.to(`conversation:${req.params.id}`).emit('message:updated', message);
    const conversation = await memberConversation(req.params.id, req.user.id); emitConversationEventToUsers(conversation, 'message:updated', message);
    return res.json({ message });
  } catch (err) { next(err); }
});
app.post('/api/conversations/:id/read', auth, async (req, res, next) => {
  try {
    if (!(await memberConversation(req.params.id, req.user.id))) return res.status(404).json({ error: 'المحادثة غير موجودة.' });
    const messageId = req.body?.messageId;
    if (!validId(messageId)) return res.status(400).json({ error: 'معرّف رسالة القراءة غير صالح.' });
    const messageIds = await storage.messages.markRead({ conversationId: req.params.id, userId: req.user.id, messageId, readAt: now() });
    const readEvent = { conversationId: req.params.id, userId: req.user.id, messageIds };
    io.to(`conversation:${req.params.id}`).emit('messages:read', readEvent);
    emitConversationEventToUsers(await memberConversation(req.params.id, req.user.id), 'messages:read', readEvent);
    return res.json({ markedCount: messageIds.length, messageIds });
  } catch (err) { next(err); }
});

const allowedMime = new Set(['image/jpeg','image/png','image/webp','image/gif','application/pdf','text/plain']);
const upload = multer({
  storage: multer.diskStorage({
    destination: async (_req, _file, cb) => { try { await fs.mkdir(uploadDir, { recursive: true }); cb(null, uploadDir); } catch (err) { cb(err); } },
    filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase().slice(0, 10)}`)
  }),
  limits: { fileSize: maxUploadBytes, files: 1 },
  fileFilter: (_req, file, cb) => allowedMime.has(file.mimetype) ? cb(null, true) : cb(Object.assign(new Error('نوع الملف غير مسموح. الأنواع المدعومة: الصور الشائعة وPDF وTXT.'), { status: 415 }))
});
async function validateFileSignature(file) {
  const handle = await fs.open(file.path, 'r');
  try {
    const buffer = Buffer.alloc(16); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0); const b = buffer.subarray(0, bytesRead); const mime = file.mimetype;
    if (mime === 'image/jpeg' && !(b.length >= 3 && b[0]===0xff && b[1]===0xd8 && b[2]===0xff)) return false;
    if (mime === 'image/png' && !b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return false;
    if (mime === 'image/gif' && !['GIF87a','GIF89a'].includes(b.toString('ascii',0,6))) return false;
    if (mime === 'image/webp' && !(b.toString('ascii',0,4)==='RIFF' && b.toString('ascii',8,12)==='WEBP')) return false;
    if (mime === 'application/pdf' && b.toString('ascii',0,5)!=='%PDF-') return false;
    if (mime === 'text/plain' && b.includes(0)) return false;
    return true;
  } finally { await handle.close(); }
}
app.post('/api/conversations/:id/attachments', auth, upload.single('file'), async (req, res, next) => {
  let storedPath;
  try {
    const conversation = await memberConversation(req.params.id, req.user.id);
    if (!conversation) { if (req.file?.path) await fs.unlink(req.file.path).catch(() => {}); return res.status(404).json({ error: 'المحادثة غير موجودة.' }); }
    if (!req.file) return res.status(400).json({ error: 'لم يتم استلام ملف.' });
    storedPath = req.file.path;
    if (!(await validateFileSignature(req.file))) { await fs.unlink(storedPath).catch(() => {}); storedPath = null; return res.status(415).json({ error: 'محتوى الملف لا يطابق نوعه المعلن.' }); }
    const currentUsage = await storage.attachments.getUsageForUser(req.user.id);
    const currentAvatar = await storage.users.getAvatar(req.user.id);
    let currentAvatarBytes = 0;
    if (currentAvatar?.storageName && /^[0-9a-f-]+\.avatar$/i.test(currentAvatar.storageName)) { try { currentAvatarBytes = (await fs.stat(path.resolve(avatarDir, path.basename(currentAvatar.storageName)))).size; } catch {} }
    if (Math.max(0, Number(currentUsage.bytes) || 0) + currentAvatarBytes + req.file.size > accountStorageQuotaBytes) { await fs.unlink(storedPath).catch(() => {}); storedPath = null; return res.status(413).json({ error: 'وصلت للحد الأقصى لمساحة حسابك. احذف ملفات قديمة أو استخدم ملفًا أصغر.', code: 'ACCOUNT_STORAGE_QUOTA_EXCEEDED' }); }
    const attachment = { id: storage.id('att'), conversationId: conversation.id, uploadedBy: req.user.id, storageName: path.basename(req.file.filename), originalName: path.basename(req.file.originalname).slice(0,180), mimeType: req.file.mimetype, size: req.file.size, createdAt: now() };
    const message = { id: storage.id('msg'), conversationId: conversation.id, senderId: req.user.id, text: '', attachment: publicAttachment(attachment), createdAt: attachment.createdAt };
    const saved = await storage.attachments.createWithMessage(attachment, message);
    io.to(`conversation:${conversation.id}`).emit('message:new', saved);
    emitMessageNotifications(conversation, saved);
    return res.status(201).json({ message: saved });
  } catch (err) { if (storedPath) await fs.unlink(storedPath).catch(() => {}); return next(err); }
});
app.post('/api/uploads', auth, (_req, res) => res.status(400).json({ error: 'ارفع الملف من داخل محادثة حتى يرتبط برسالة وتُطبق صلاحيات التنزيل.' }));
app.get('/api/attachments/:id/download', auth, async (req, res, next) => {
  try {
    const attachment = await storage.attachments.getById(req.params.id);
    const linkedMessage = attachment?.messageId ? await storage.messages.getById(attachment.messageId) : null;
    if (!attachment || attachment.status === 'orphaned' || linkedMessage?.deleted || !(await storage.conversations.isMember(attachment.conversationId, req.user.id))) return res.status(404).json({ error: 'الملف غير موجود أو لا تملك صلاحية الوصول إليه.' });
    const fullPath = path.resolve(uploadDir, attachment.storageName);
    if (path.dirname(fullPath) !== uploadDir) return res.status(404).json({ error: 'الملف غير موجود.' });
    try { await fs.access(fullPath); } catch { return res.status(404).json({ error: 'الملف غير موجود على الخادم.' }); }
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(attachment.originalName)}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.sendFile(fullPath, err => { if (err && !res.headersSent) res.status(404).json({ error: 'الملف غير موجود على الخادم.' }); });
  } catch (err) { next(err); }
});

io.use(async (socket, next) => {
  try { const token = socket.handshake.auth?.token; if (typeof token !== 'string' || !token) return next(new Error('AUTH_REQUIRED')); socket.user = await authFromToken(token); return next(); }
  catch { return next(new Error('INVALID_TOKEN')); }
});
io.on('connection', socket => {
  const uid = socket.user.id;
  const typingLastSent = new Map();
  socket.join(`user:${uid}`);
  socket.data.sessionId = socket.user.sessionId;
  socket.join(`session:${socket.user.sessionId}`);
  const connectedState = presence.connect(uid, socket.id);

  const broadcastPresence = async (online, lastSeenAt = null) => {
    try {
      const conversations = await storage.conversations.listForUser(uid);
      for (const conversation of conversations) for (const member of conversation.members || []) presence.rememberLastSeen(member.id, member.lastSeenAt);
      const peers = new Set(conversations.flatMap(c => c.memberIds || []).filter(id => id !== uid));
      for (const peerId of peers) {
        const settings = { ...privacyDefaults, ...(await storage.users.getPrivacy(uid)) };
        if (settings.showOnlineStatus !== 'nobody') io.to(`user:${peerId}`).emit('presence:update', { userId: uid, online, lastSeenAt: settings.showLastSeen === 'nobody' ? null : lastSeenAt });
      }
      const snapshot = presence.snapshot([...peers, uid]);
      for (const targetId of [...peers, uid]) {
        const settings = { ...privacyDefaults, ...(await storage.users.getPrivacy(targetId)) };
        if (settings.showOnlineStatus === 'nobody' && targetId !== uid) delete snapshot[targetId];
        else if (settings.showLastSeen === 'nobody') snapshot[targetId].lastSeenAt = null;
      }
      socket.emit('presence:snapshot', snapshot);
    } catch (err) { console.error('Presence broadcast failed:', err.message); }
  };

  if (connectedState.becameOnline) void broadcastPresence(true, connectedState.lastSeenAt);
  else void broadcastPresence(true, connectedState.lastSeenAt);

  socket.on('conversation:join', async conversationId => {
    try {
      if (typeof conversationId !== 'string' || !(await storage.conversations.isMember(conversationId, uid))) { socket.emit('app:error', { error: 'غير مسموح بالانضمام إلى هذه المحادثة.' }); return; }
      socket.join(`conversation:${conversationId}`);
    } catch { socket.emit('app:error', { error: 'تعذر التحقق من صلاحية المحادثة.' }); }
  });
  socket.on('conversation:leave', conversationId => {
    if (typeof conversationId === 'string') {
      socket.leave(`conversation:${conversationId}`);
      socket.to(`conversation:${conversationId}`).emit('typing:update', { conversationId, userId: uid, typing: false });
      typingLastSent.delete(conversationId);
    }
  });
  socket.on('typing:start', async payload => {
    const conversationId = payload?.conversationId;
    if (typeof conversationId !== 'string' || !validId(conversationId)) return;
    const previous = typingLastSent.get(conversationId) || 0;
    if (Date.now() - previous < 700) return;
    typingLastSent.set(conversationId, Date.now());
    try {
      if (!(await storage.conversations.isMember(conversationId, uid))) { typingLastSent.delete(conversationId); return; }
      socket.to(`conversation:${conversationId}`).emit('typing:update', { conversationId, userId: uid, typing: true });
    } catch { /* A typing signal is best-effort and must not interrupt messaging. */ }
  });
  socket.on('typing:stop', async payload => {
    const conversationId = payload?.conversationId;
    if (typeof conversationId !== 'string' || !validId(conversationId)) return;
    try {
      if (!(await storage.conversations.isMember(conversationId, uid))) return;
      typingLastSent.delete(conversationId);
      socket.to(`conversation:${conversationId}`).emit('typing:update', { conversationId, userId: uid, typing: false });
    } catch { /* Best effort. */ }
  });
  socket.on('disconnect', async () => {
    for (const conversationId of typingLastSent.keys()) {
      socket.to(`conversation:${conversationId}`).emit('typing:update', { conversationId, userId: uid, typing: false });
    }
    const state = presence.disconnect(uid, socket.id);
    if (state.wentOffline) {
      try { await storage.users.setLastSeen(uid, state.lastSeenAt); } catch (err) { console.error('Could not persist last-seen timestamp:', err.message); }
      await broadcastPresence(false, state.lastSeenAt);
    }
  });
});

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) { const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400; return res.status(status).json({ error: status === 413 ? 'حجم الملف أكبر من الحد المسموح.' : 'تعذر معالجة الملف.' }); }
  if (err.code === 'GROUP_NOT_FOUND') return res.status(404).json({ error: 'المجموعة غير موجودة.' });
  if (err.code === 'GROUP_MEMBER_NOT_FOUND') return res.status(404).json({ error: 'العضو غير موجود في المجموعة.' });
  if (err.code === 'GROUP_FORBIDDEN') return res.status(403).json({ error: 'لا تملك صلاحية إدارة هذه المجموعة.' });
  if (err.code === 'GROUP_OWNER_REQUIRED') return res.status(403).json({ error: 'تغيير أدوار الأعضاء متاح لمالك المجموعة فقط.' });
  if (err.code === 'GROUP_OWNER_PROTECTED') return res.status(400).json({ error: 'لا يمكن إزالة مالك المجموعة؛ أضف ميزة نقل الملكية أولًا.' });
  if (err.code === 'GROUP_LIMIT') return res.status(400).json({ error: 'الحد الأقصى للمجموعة 100 عضو.' });
  if (err.code === 'MESSAGE_NOT_FOUND') return res.status(404).json({ error: 'الرسالة غير موجودة أو تم حذفها.' });
  if (err.code === 'MESSAGE_FORBIDDEN') return res.status(403).json({ error: 'يمكنك تعديل أو حذف رسائلك فقط.' });
  if (err.code === 'MESSAGE_PIN_FORBIDDEN') return res.status(403).json({ error: 'تثبيت رسائل المجموعة متاح للمالك والمشرفين فقط.' });
  if (err.code === 'MESSAGE_REFERENCE_INVALID') return res.status(400).json({ error: 'الرسالة المشار إليها غير موجودة داخل هذه المحادثة.' });
  if (err.code === 'ATTACHMENT_MESSAGE_IMMUTABLE') return res.status(400).json({ error: 'لا يمكن تعديل نص رسالة تحتوي على مرفق.' });
  if (err.status) return res.status(err.status).json({ error: err.message });
  if (err.message === 'Origin not allowed by CORS') return res.status(403).json({ error: 'Origin not allowed.' });
  console.error('Unhandled request error:', err.message);
  return res.status(500).json({ error: 'حدث خطأ داخلي. حاول مرة أخرى.' });
});

let shuttingDown = false;
(async () => {
  await storage.init();
  server.on('error', err => {
    console.error('HTTP server error:', err.message);
    process.exitCode = 1;
    void shutdown();
  });
  server.listen(port, host, () => console.log(`Wasl API listening on http://${host}:${port} (${storage.mode})`));
})().catch(err => {
  console.error('Startup failed:', err.message);
  process.exit(1);
});
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const timeout = setTimeout(() => {
    console.error('Graceful shutdown timed out.');
    process.exit(1);
  }, 10_000);
  timeout.unref();
  io.close(async () => {
    try { await storage.close(); process.exit(process.exitCode || 0); }
    catch (err) { console.error('Storage shutdown failed:', err.message); process.exit(1); }
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
