'use strict';

const TOKEN_KEY = 'wasl-session-token-v1';
const THEME_KEY = 'wasl-theme';
const PREFS_KEY = 'wasl-web-preferences-v1';
const PROFILE_IMAGE_KEY = 'wasl-profile-image-v1';
const ACCENT_KEY = 'wasl-accent-color-v1';
const allowedAccents = ['#6658e8', '#168bcb', '#159a78', '#d05b8b', '#c47b25'];
const defaultPrefs = { compact: false, enterToSend: true, messageSound: false, desktopNotifications: false };
let webPrefs = { ...defaultPrefs };
let settingsBusy = false;
const MAX_MESSAGE_LENGTH = 2000;
const MAX_FILE_SIZE = 5 * 1024 * 1024;
const colors = ['#7770d9', '#ed9b74', '#55bba7', '#649fdf', '#d18ab5', '#bba16a'];
const $ = id => document.getElementById(id);
let token = null;
let currentUser = null;
let chats = [];
let activeId = null;
let socket = null;
let authMode = 'login';
let toastTimer;
let pendingReplyId = null;
let pendingForwardId = null;
const seenMessageIds = new Set();
const presenceByUser = new Map();
const typingByConversation = new Map();
let typingStopTimer = null;

function showToast(message) {
  const el = $('toast'); if (!el) return;
  el.textContent = message; el.classList.add('show'); clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}
function playMessageSound() {
  if (!webPrefs.messageSound || document.hidden) return;
  try { const AudioContextClass = window.AudioContext || window.webkitAudioContext; if (!AudioContextClass) return; const context = new AudioContextClass(); const oscillator = context.createOscillator(); const gain = context.createGain(); oscillator.type = 'sine'; oscillator.frequency.value = 660; gain.gain.setValueAtTime(0.0001, context.currentTime); gain.gain.exponentialRampToValueAtTime(0.035, context.currentTime + 0.015); gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.12); oscillator.connect(gain); gain.connect(context.destination); oscillator.start(); oscillator.stop(context.currentTime + 0.13); oscillator.onended = () => context.close().catch(() => {}); } catch {}
}
function initials(name) { return [...String(name || '').trim()][0] || '؟'; }
function getProfileImage() { try { const value = localStorage.getItem(PROFILE_IMAGE_KEY); return value && /^data:image\/(png|jpeg|webp);base64,/.test(value) ? value : ''; } catch { return ''; } }
let remoteAvatarObjectUrl = null;
const remoteAvatarCache = new Map();
async function remoteAvatar(url) { if (!url || !token) return null; if (remoteAvatarCache.has(url)) return remoteAvatarCache.get(url); const pending = fetch(url, { headers: authHeaders() }).then(async response => { if (!response.ok) return null; const blob = await response.blob(); if (!['image/jpeg','image/png','image/webp'].includes(blob.type)) return null; return URL.createObjectURL(blob); }).catch(() => null); remoteAvatarCache.set(url, pending); const value = await pending; if (!value) remoteAvatarCache.delete(url); else remoteAvatarCache.set(url, value); return value; }
async function paintProfileImage() {
  const localImage = getProfileImage(); const nodes = [$('profileAvatar'), $('profilePreview')].filter(Boolean);
  for (const node of nodes) { node.textContent = localImage ? '' : initials(currentUser?.name); node.style.backgroundImage = localImage ? `url("${localImage}")` : ''; node.classList.toggle('has-profile-image', Boolean(localImage)); }
  if (!token || !currentUser?.avatarUrl) return;
  try {
    const nextUrl = await remoteAvatar(currentUser.avatarUrl); if (!nextUrl) return; remoteAvatarObjectUrl = nextUrl;
    for (const node of nodes) { node.textContent = ''; node.style.backgroundImage = `url("${nextUrl}")`; node.classList.add('has-profile-image'); }
  } catch { /* Keep initials/local fallback when offline. */ }
}
function applyAccent(value, persist = false) { const color = allowedAccents.includes(value) ? value : allowedAccents[0]; document.documentElement.style.setProperty('--purple', color); document.documentElement.style.setProperty('--purple-light', `${color}20`); if (persist) { try { localStorage.setItem(ACCENT_KEY, color); } catch {} } if ($('accentColor')) $('accentColor').value = color; }
function timeOf(date) {
  const d = new Date(date);
  return Number.isNaN(d.getTime()) ? '' : new Intl.DateTimeFormat('ar-EG', { hour: 'numeric', minute: '2-digit' }).format(d);
}
function mobile() { return window.matchMedia('(max-width: 800px)').matches; }
function lastSeenLabel(value) {
  if (!value) return 'غير متصل';
  const date = new Date(value); if (Number.isNaN(date.getTime())) return 'غير متصل';
  return `آخر ظهور ${new Intl.DateTimeFormat('ar-EG', { dateStyle: 'medium', timeStyle: 'short' }).format(date)}`;
}
function chatPresenceLabel(chat) {
  const typing = [...(typingByConversation.get(chat.id) || [])].filter(id => id !== currentUser?.id);
  if (typing.length) {
    if (typing.length === 1) return `${chat.members?.find(u => u.id === typing[0])?.name || 'أحد الأعضاء'} يكتب الآن…`;
    return `${typing.length} أعضاء يكتبون الآن…`;
  }
  const peers = (chat.memberIds || []).filter(id => id !== currentUser?.id);
  const online = peers.filter(id => presenceByUser.get(id)?.online).length;
  if (chat.type === 'group') return online ? `${online} متصل الآن` : 'مجموعة · الحالة غير متصلة';
  const peer = peers[0]; const status = peer ? presenceByUser.get(peer) : null;
  return status?.online ? 'متصل الآن' : lastSeenLabel(status?.lastSeenAt);
}
function authHeaders(extra = {}) { return { ...extra, Authorization: `Bearer ${token}` }; }
async function api(url, options = {}) {
  const headers = { ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...(options.headers || {}) };
  const response = await fetch(url, { ...options, headers });
  let data = {};
  try { data = await response.json(); } catch {}
  if (response.status === 401 && token && !url.startsWith('/api/auth/login') && !url.startsWith('/api/auth/register')) {
    logout(false); throw new Error(data.error || 'انتهت جلسة الدخول. سجّل الدخول مرة أخرى.');
  }
  if (!response.ok) throw new Error(data.error || `تعذر تنفيذ الطلب (${response.status}).`);
  return data;
}
function showAuth(message = '') {
  $('authScreen').hidden = false;
  $('authError').textContent = message;
  document.querySelector('.app-shell').classList.add('auth-locked');
  setAuthMode(authMode);
}
function hideAuth() {
  $('authScreen').hidden = true;
  document.querySelector('.app-shell').classList.remove('auth-locked');
}
function setAuthMode(mode) {
  authMode = mode;
  const register = mode === 'register';
  $('authTitle').textContent = register ? 'إنشاء حساب في وصل' : 'أهلًا بيك في وصل';
  $('authDescription').textContent = register ? 'أنشئ حسابك وابدأ مراسلة أصدقائك.' : 'سجّل الدخول لعرض محادثاتك الحقيقية.';
  $('registerNameWrap').hidden = !register;
  $('authName').required = register;
  $('authPassword').autocomplete = register ? 'new-password' : 'current-password';
  $('authSubmit').textContent = register ? 'إنشاء الحساب' : 'تسجيل الدخول';
  $('authModeBtn').textContent = register ? 'لديك حساب بالفعل؟ تسجيل الدخول' : 'إنشاء حساب جديد';
  $('authError').textContent = '';
}
function logout(showMessage = true) {
  if (socket) { socket.disconnect(); socket = null; }
  token = null; currentUser = null; chats = []; activeId = null; seenMessageIds.clear();
  for (const value of remoteAvatarCache.values()) if (typeof value === 'string' && value.startsWith('blob:')) URL.revokeObjectURL(value); remoteAvatarCache.clear(); remoteAvatarObjectUrl = null;
  try { sessionStorage.removeItem(TOKEN_KEY); } catch {}
  $('profileName').textContent = 'ضيف'; $('profileEmail').textContent = 'غير مسجل الدخول'; $('profileAvatar').textContent = '؟';
  $('chatList').replaceChildren(); $('chatCount').textContent = '0'; renderEmptyConversation();
  showAuth(); if (showMessage) showToast('تم تسجيل الخروج.');
}
function avatar(chat, cls = '') {
  const el = document.createElement('div');
  el.className = `avatar ${cls}${chat.online ? ' online' : ''}`.trim();
  el.style.background = chat.color || colors[0]; el.textContent = initials(chat.name); el.setAttribute('aria-hidden', 'true');
  if (chat.avatarUrl && token) remoteAvatar(chat.avatarUrl).then(url => { if (url && el.isConnected) { el.textContent = ''; el.style.backgroundImage = `url(\"${url}\")`; el.classList.add('has-profile-image'); } });
  return el;
}
function normalizeMessage(message) {
  return { id: message.id, conversationId: message.conversationId, senderId: message.senderId,
    from: message.senderId === currentUser.id ? 'me' : 'them', text: String(message.text || '').slice(0, MAX_MESSAGE_LENGTH), attachment: message.attachment || null, time: timeOf(message.createdAt), createdAt: message.createdAt, editedAt: message.editedAt || null, deleted: Boolean(message.deleted || message.deletedAt), deletedAt: message.deletedAt || null, pinnedAt: message.pinnedAt || null, pinnedBy: message.pinnedBy || null, replyToMessageId: message.replyToMessageId || null, forwardedFromMessageId: message.forwardedFromMessageId || null, readBy: Array.isArray(message.readBy) ? message.readBy : [] };
}
function chatName(conversation) {
  if (conversation.title && conversation.title !== 'محادثة مباشرة') return conversation.title;
  const otherId = conversation.memberIds.find(id => id !== currentUser.id);
  const other = conversation.members?.find(u => u.id === otherId);
  return other?.name || other?.email || 'محادثة';
}
async function loadConversations() {
  const data = await api('/api/conversations', { headers: authHeaders() });
  chats = data.conversations.map((c, i) => { const otherId = (c.memberIds || []).find(id => id !== currentUser.id); const other = (c.members || []).find(user => user.id === otherId); return { id: c.id, type: c.type || 'direct', title: c.title, memberIds: c.memberIds, members: c.members || [], memberRoles: c.memberRoles || {}, name: chatName(c), avatarUrl: c.type === 'group' ? null : (other?.avatarUrl || null), online: false, unread: 0, color: colors[i % colors.length], messages: [] }; });
  renderList();
  if (activeId && chats.some(c => c.id === activeId)) await openChat(activeId, false);
  else if (chats.length) await openChat(chats[0].id, false);
  else { activeId = null; renderEmptyConversation(); }
}
async function openChat(id, focus = true) {
  const chat = chats.find(item => item.id === id); if (!chat) return;
  if (socket && activeId && activeId !== id) socket.emit('conversation:leave', activeId);
  activeId = id; chat.unread = 0;
  try {
    const data = await api(`/api/conversations/${encodeURIComponent(id)}/messages?limit=100`, { headers: authHeaders() });
    chat.messages = data.messages.map(normalizeMessage);
    chat.messages.forEach(m => seenMessageIds.add(m.id));
    if (socket?.connected) socket.emit('conversation:join', id);
    const lastIncoming = [...chat.messages].reverse().find(m => m.from !== 'me' && !m.deleted);
    if (lastIncoming) markConversationRead(chat, lastIncoming.id).catch(() => {});
    renderList(); renderChat();
    if (mobile()) document.querySelector('.app-shell').classList.add('chat-open');
    if (focus) $('messageInput').focus();
  } catch (error) { showToast(error.message); }
}
function renderList() {
  const list = $('chatList'); if (!list) return;
  list.replaceChildren();
  const query = $('searchInput').value.trim().toLocaleLowerCase('ar');
  const found = chats.filter(chat => chat.name.toLocaleLowerCase('ar').includes(query) || chat.messages.some(m => m.text.toLocaleLowerCase('ar').includes(query)));
  $('chatCount').textContent = String(chats.length);
  if (!found.length) {
    const empty = document.createElement('div'); empty.className = 'empty-list';
    empty.textContent = query ? 'لا توجد محادثات تطابق بحثك.' : 'لا توجد محادثات بعد. اضغط + وابدأ باستخدام البريد الإلكتروني لصديقك.'; list.append(empty); return;
  }
  found.forEach(chat => {
    const button = document.createElement('button'); button.type = 'button'; button.className = `chat-item${chat.id === activeId ? ' active' : ''}`; button.setAttribute('role', 'listitem');
    button.setAttribute('aria-label', `محادثة مع ${chat.name}`); button.append(avatar(chat));
    const copy = document.createElement('div'); copy.className = 'chat-copy'; const top = document.createElement('div'); top.className = 'chat-top';
    const name = document.createElement('strong'); name.textContent = chat.name; const time = document.createElement('time'); time.textContent = chat.messages.at(-1)?.time || '';
    top.append(name, time); const bottom = document.createElement('div'); bottom.className = 'chat-bottom'; const preview = document.createElement('span'); preview.textContent = chat.messages.at(-1)?.text || 'ابدأ المحادثة الآن'; bottom.append(preview); if (chat.unread > 0) { const unread = document.createElement('span'); unread.className = 'unread-count'; unread.textContent = String(chat.unread); bottom.append(unread); } copy.append(top, bottom); button.append(copy);
    button.addEventListener('click', () => openChat(chat.id)); list.append(button);
  });
}
function renderEmptyConversation() {
  $('contactName').textContent = 'مرحبًا بك في وصل'; $('contactStatus').textContent = 'اختر محادثة أو أنشئ محادثة جديدة';
  const old = $('headerAvatar'); old.className = 'avatar header-avatar'; old.style.background = ''; old.textContent = '✦';
  const area = $('messagesArea'); area.replaceChildren(); const empty = document.createElement('div'); empty.className = 'empty-list'; empty.textContent = 'ابدأ بإنشاء محادثة جديدة من زر + في القائمة.'; area.append(empty);
}
function renderChat() {
  const chat = chats.find(item => item.id === activeId); if (!chat) { renderEmptyConversation(); return; }
  $('contactName').textContent = chat.name; $('contactStatus').textContent = socket?.connected ? chatPresenceLabel(chat) : 'جارٍ الاتصال…';
  const old = $('headerAvatar'); const next = avatar(chat, 'header-avatar'); next.id = 'headerAvatar'; old.replaceWith(next);
  const area = $('messagesArea'); area.replaceChildren(); const divider = document.createElement('div'); divider.className = 'day-divider'; const label = document.createElement('span'); label.textContent = 'المحادثة'; divider.append(label); area.append(divider);
  if (!chat.messages.length) { const empty = document.createElement('div'); empty.className = 'empty-list'; empty.textContent = `هذه بداية محادثتك مع ${chat.name} 👋`; area.append(empty); }
  chat.messages.forEach(message => {
    const row = document.createElement('div'); row.className = `message-row${message.from === 'me' ? ' mine' : ''}`; if (message.from !== 'me') row.append(avatar(chat, 'message-avatar'));
    const content = document.createElement('div'); content.className = 'message-content';
    if (message.from !== 'me') { const sender = document.createElement('div'); sender.className = 'sender-label'; sender.textContent = chat.name; content.append(sender); }
    if (message.replyToMessageId) { const ref = chat.messages.find(m => m.id === message.replyToMessageId); const quote = document.createElement('div'); quote.className = 'message-reference'; quote.textContent = `↪ رد على: ${ref && !ref.deleted ? ref.text.slice(0, 100) : 'رسالة سابقة'}`; content.append(quote); }
    if (message.forwardedFromMessageId) { const forwarded = document.createElement('div'); forwarded.className = 'message-reference'; forwarded.textContent = '↗ رسالة مُعاد توجيهها'; content.append(forwarded); }
    if (message.pinnedAt) { const pinned = document.createElement('div'); pinned.className = 'message-reference'; pinned.textContent = '📌 رسالة مثبتة'; content.append(pinned); }
    if (message.deleted) { const deleted = document.createElement('div'); deleted.className = 'bubble deleted-bubble'; deleted.textContent = 'تم حذف هذه الرسالة'; content.append(deleted); }
    else if (message.text) { const bubble = document.createElement('div'); bubble.className = 'bubble'; bubble.textContent = message.text; content.append(bubble); }
    if (!message.deleted && message.attachment?.id) {
      const fileButton = document.createElement('button'); fileButton.type = 'button'; fileButton.className = 'bubble attachment-bubble';
      fileButton.textContent = `📎 ${message.attachment.originalName || 'ملف مرفق'} · ${Math.max(1, Math.ceil((message.attachment.size || 0) / 1024))} KB`;
      fileButton.addEventListener('click', () => downloadAttachment(message.attachment)); content.append(fileButton);
    }
    const actions = document.createElement('div'); actions.className = 'message-actions';
    if (!message.deleted) { const actionBtn = document.createElement('button'); actionBtn.type = 'button'; actionBtn.className = 'message-action-btn'; actionBtn.textContent = 'خيارات'; actionBtn.setAttribute('aria-label', 'خيارات الرسالة'); actionBtn.addEventListener('click', () => messageActions(chat, message)); actions.append(actionBtn); }
    const meta = document.createElement('div'); meta.className = 'message-meta';
    const readCount = message.readBy.filter(id => id !== message.senderId).length;
    meta.textContent = `${message.time}${message.editedAt ? ' · معدلة' : ''}${message.from === 'me' ? `  ${readCount ? '✓✓ تمت القراءة' : '✓ تم الإرسال'}` : ''}`;
    content.append(meta, actions); row.append(content); area.append(row);
  }); area.scrollTop = area.scrollHeight;
}
function connectSocket() {
  if (typeof window.io !== 'function') { $('liveStatus').textContent = 'الوقت الفعلي غير متاح'; return; }
  if (socket) socket.disconnect();
  socket = window.io({ auth: { token }, reconnection: true, reconnectionAttempts: 8, timeout: 10000 });
  socket.on('connect', () => {
    $('liveStatus').textContent = 'متصل بالخادم'; $('connectionNotice').textContent = 'متصل بالخادم';
    if (activeId) socket.emit('conversation:join', activeId); renderChat();
  });
  socket.on('disconnect', () => { $('liveStatus').textContent = 'إعادة الاتصال…'; $('connectionNotice').textContent = 'الاتصال منقطع — جارٍ إعادة المحاولة'; renderChat(); });
  socket.on('connect_error', err => { $('liveStatus').textContent = 'تعذر الاتصال'; if (/TOKEN|AUTH/.test(err.message || '')) logout(); });
  socket.on('app:error', data => showToast(data?.error || 'حدث خطأ في الاتصال الفوري.'));
  socket.on('group:updated', async event => { if (event?.conversationId && chats.some(c => c.id === event.conversationId)) { try { await loadConversations(); } catch {} } });
  socket.on('presence:snapshot', snapshot => {
    if (!snapshot || typeof snapshot !== 'object') return;
    for (const [userId, state] of Object.entries(snapshot)) presenceByUser.set(userId, { online: Boolean(state?.online), lastSeenAt: state?.lastSeenAt || null });
    if (activeId) renderChat(); renderList();
  });
  socket.on('presence:update', event => {
    if (!event?.userId || event.userId === currentUser?.id) return;
    presenceByUser.set(event.userId, { online: Boolean(event.online), lastSeenAt: event.lastSeenAt || null });
    if (activeId) renderChat(); renderList();
  });
  socket.on('typing:update', event => {
    if (!event?.conversationId || !event.userId || event.userId === currentUser?.id) return;
    const ids = typingByConversation.get(event.conversationId) || new Set();
    if (event.typing) ids.add(event.userId); else ids.delete(event.userId);
    if (ids.size) typingByConversation.set(event.conversationId, ids); else typingByConversation.delete(event.conversationId);
    if (activeId === event.conversationId) renderChat();
    if (event.typing) setTimeout(() => { const current = typingByConversation.get(event.conversationId); if (current?.delete(event.userId)) { if (!current.size) typingByConversation.delete(event.conversationId); if (activeId === event.conversationId) renderChat(); } }, 5500);
  });
  socket.on('message:sync', message => applyMessageEvent(message));
  socket.on('notification:new', event => {
    if (!event?.conversationId || event.senderId === currentUser?.id) return;
    showToast(`رسالة جديدة: ${(event.preview || 'رسالة جديدة').slice(0, 70)}`); playMessageSound();
    const chat = chats.find(item => item.id === event.conversationId);
    if (chat) { chat.unread = (chat.unread || 0) + (activeId === chat.id && !document.hidden ? 0 : 1); renderList(); }
    if (document.hidden && webPrefs.desktopNotifications && window.Notification?.permission === 'granted') {
      const notification = new Notification('وصل', { body: event.preview || 'رسالة جديدة', tag: `wasl-${event.conversationId}` });
      notification.onclick = () => { window.focus(); if (chat) openChat(chat.id); notification.close(); };
    }
  });
  socket.on('message:new', message => {
    if (!message?.id || seenMessageIds.has(message.id)) return;
    seenMessageIds.add(message.id);
    const chat = chats.find(c => c.id === message.conversationId); if (!chat) return;
    chat.messages.push(normalizeMessage(message));
    if (chat.id === activeId) { renderChat(); if (message.senderId !== currentUser.id) markConversationRead(chat, message.id).catch(() => {}); } renderList();
  });
  socket.on('message:updated', message => applyMessageEvent(message));
  socket.on('message:deleted', message => applyMessageEvent(message));
  socket.on('messages:read', event => {
    const chat = chats.find(c => c.id === event?.conversationId); if (!chat) return;
    for (const message of chat.messages) if (event.messageIds?.includes(message.id) && !message.readBy.includes(event.userId)) message.readBy.push(event.userId);
    if (chat.id === activeId) renderChat();
  });
}
function applyMessageEvent(raw) {
  if (!raw?.id) return;
  seenMessageIds.add(raw.id);
  const chat = chats.find(c => c.id === raw.conversationId); if (!chat) return;
  const index = chat.messages.findIndex(m => m.id === raw.id); const normalized = normalizeMessage(raw);
  if (index >= 0) chat.messages[index] = { ...chat.messages[index], ...normalized, readBy: Array.isArray(raw.readBy) ? normalized.readBy : chat.messages[index].readBy, attachment: raw.attachment || chat.messages[index].attachment };
  else chat.messages.push(normalized);
  if (chat.id === activeId) renderChat(); renderList();
}
async function markConversationRead(chat, messageId) {
  const result = await api(`/api/conversations/${encodeURIComponent(chat.id)}/read`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ messageId }) });
  for (const message of chat.messages) if (result.messageIds?.includes(message.id) && !message.readBy.includes(currentUser.id)) message.readBy.push(currentUser.id);
  if (chat.id === activeId) renderChat();
}
async function messageActions(chat, message) {
  const own = message.senderId === currentUser.id;
  const role = chat.memberRoles?.[currentUser?.id] || 'member';
  const canPin = chat.type !== 'group' || ['owner', 'admin'].includes(role);
  const choices = ['1 رد على الرسالة', ...(!message.attachment ? ['2 إعادة توجيه'] : []), ...(own && !message.attachment ? ['3 تعديل الرسالة'] : []), ...(own ? ['4 حذف الرسالة'] : []), ...(canPin ? [`${own ? '5' : '3'} ${message.pinnedAt ? 'إلغاء تثبيت' : 'تثبيت'} الرسالة`] : [])].join('\n');
  const action = window.prompt(`اختر عملية:\n${choices}\nاكتب رقم العملية`);
  if (!action) return;
  const value = action.trim();
  try {
    if (value === '1') { pendingReplyId = message.id; pendingForwardId = null; $('messageInput').value = ''; $('messageInput').placeholder = `رد على: ${message.text.slice(0, 50) || 'رسالة'}…`; $('messageInput').focus(); showToast('اكتب ردك ثم أرسله.'); }
    else if (value === '2') { pendingForwardId = message.id; pendingReplyId = null; $('messageInput').value = message.text || ''; $('messageInput').placeholder = 'اكتب رسالة لإعادة توجيهها…'; $('messageInput').focus(); showToast('عدّل النص إذا أردت ثم أرسله لإعادة التوجيه.'); }
    else if (own && value === '3' && !message.attachment) {
      const text = window.prompt('تعديل نص الرسالة (حتى 2000 حرف):', message.text); if (text === null) return;
      const data = await api(`/api/conversations/${encodeURIComponent(chat.id)}/messages/${encodeURIComponent(message.id)}`, { method: 'PATCH', headers: authHeaders(), body: JSON.stringify({ text }) }); applyMessageEvent(data.message); showToast('تم تعديل الرسالة.');
    } else if (own && value === '4') {
      if (!window.confirm('حذف الرسالة عند جميع أعضاء المحادثة؟')) return;
      const data = await api(`/api/conversations/${encodeURIComponent(chat.id)}/messages/${encodeURIComponent(message.id)}`, { method: 'DELETE', headers: authHeaders() }); applyMessageEvent(data.message); showToast('تم حذف الرسالة.');
    } else if ((own && value === '5' || !own && value === '3') && canPin) {
      const data = await api(`/api/conversations/${encodeURIComponent(chat.id)}/messages/${encodeURIComponent(message.id)}/pin`, { method: 'PATCH', headers: authHeaders(), body: JSON.stringify({ pinned: !message.pinnedAt }) }); applyMessageEvent(data.message); showToast(message.pinnedAt ? 'تم إلغاء التثبيت.' : 'تم تثبيت الرسالة.');
    } else showToast('اختيار غير صحيح.');
  } catch (error) { showToast(error.message); }
}

async function initializeSession() {
  try { token = sessionStorage.getItem(TOKEN_KEY); } catch { token = null; }
  if (!token) { showAuth(); renderList(); renderEmptyConversation(); return; }
  try {
    const data = await api('/api/auth/me', { headers: authHeaders() }); currentUser = data.user;
    $('profileName').textContent = currentUser.name; $('profileEmail').textContent = currentUser.email; paintProfileImage();
    hideAuth(); await loadConversations(); connectSocket();
  } catch (error) { showAuth(error.message); }
}
$('authForm').addEventListener('submit', async event => {
  event.preventDefault(); $('authSubmit').disabled = true; $('authError').textContent = '';
  const payload = { email: $('authEmail').value.trim(), password: $('authPassword').value };
  if (authMode === 'register') payload.name = $('authName').value.trim();
  try {
    const data = await api(authMode === 'register' ? '/api/auth/register' : '/api/auth/login', { method: 'POST', body: JSON.stringify(payload) });
    token = data.token; currentUser = data.user; try { sessionStorage.setItem(TOKEN_KEY, token); } catch {}
    $('profileName').textContent = currentUser.name; $('profileEmail').textContent = currentUser.email; paintProfileImage();
    hideAuth(); await loadConversations(); connectSocket(); showToast(authMode === 'register' ? 'تم إنشاء الحساب بنجاح.' : 'تم تسجيل الدخول بنجاح.'); $('authPassword').value = '';
  } catch (error) { $('authError').textContent = error.message; }
  finally { $('authSubmit').disabled = false; }
});
$('authModeBtn').addEventListener('click', () => setAuthMode(authMode === 'login' ? 'register' : 'login'));
function readWebPrefs() {
  try { const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}'); webPrefs = { ...defaultPrefs, ...saved }; } catch { webPrefs = { ...defaultPrefs }; }
  $('prefDark').checked = document.body.classList.contains('dark');
  try { applyAccent(localStorage.getItem(ACCENT_KEY) || allowedAccents[0]); } catch { applyAccent(allowedAccents[0]); }
  $('prefCompact').checked = Boolean(webPrefs.compact);
  $('prefEnter').checked = Boolean(webPrefs.enterToSend);
  $('prefSound').checked = Boolean(webPrefs.messageSound);
  $('prefDesktop').checked = Boolean(webPrefs.desktopNotifications);
  $('desktopPermissionNote').textContent = !('Notification' in window) ? 'المتصفح لا يدعم إشعارات سطح المكتب.' : `حالة إذن المتصفح: ${Notification.permission === 'granted' ? 'مسموح' : Notification.permission === 'denied' ? 'مرفوض' : 'لم يُطلب بعد'}.`;
}
function setSettingsStatus(message, isError = false) {
  const el = $('settingsStatus'); el.textContent = message; el.style.color = isError ? '#e75d70' : '';
}
function switchSettingsTab(name) {
  document.querySelectorAll('[data-settings-tab]').forEach(button => button.classList.toggle('active', button.dataset.settingsTab === name));
  document.querySelectorAll('[data-settings-panel]').forEach(panel => { const active = panel.dataset.settingsPanel === name; panel.hidden = !active; panel.classList.toggle('active', active); });
  const titles = { general: ['إعدادات وصل', 'تحكّم في شكل وتجربة المراسلة.'], profile: ['الملف الشخصي', 'حدّث الاسم والصورة واللون المميز.'], privacy: ['الخصوصية', 'اختار مين يشوف نشاطك.'], notifications: ['الإشعارات', 'تابع الإشعارات المحفوظة في حسابك.'], sessions: ['الأجهزة والجلسات', 'راجع الأجهزة التي سجلت الدخول منها.'], storage: ['مساحة التخزين', 'تابع استخدام الملفات والمساحة المتبقية.'], about: ['عن وصل', 'معلومات سريعة عن الموقع.'] };
  $('settingsTitle').textContent = titles[name][0]; $('settingsSubtitle').textContent = titles[name][1];
}
async function loadPrivacySettings() {
  if (!token) throw new Error('سجّل الدخول لإدارة إعدادات الخصوصية.');
  const data = await api('/api/account/privacy', { headers: authHeaders() }); const settings = data.settings || {};
  $('privacyLastSeen').value = ['everyone','contacts','nobody'].includes(settings.showLastSeen) ? settings.showLastSeen : 'everyone';
  $('privacyOnline').value = ['everyone','contacts','nobody'].includes(settings.showOnlineStatus) ? settings.showOnlineStatus : 'everyone';
  $('privacyNotifications').checked = settings.notificationsEnabled !== false;
}
async function loadSettingsNotifications() {
  const list = $('settingsNotifications'); list.replaceChildren();
  if (!token) { list.innerHTML = '<p class="settings-empty">سجّل الدخول لعرض إشعارات حسابك.</p>'; $('notificationSummary').textContent = 'تسجيل الدخول مطلوب.'; return; }
  const data = await api('/api/notifications?limit=30', { headers: authHeaders() });
  $('notificationSummary').textContent = `${data.unreadCount || 0} غير مقروء · ${data.notifications.length} إشعارًا في القائمة`;
  if (!data.notifications.length) { list.innerHTML = '<p class="settings-empty">مفيش إشعارات جديدة. كله هادي هنا ✨</p>'; return; }
  for (const notification of data.notifications) {
    const row = document.createElement('article'); row.className = `settings-item${notification.readAt ? '' : ' unread-item'}`;
    const copy = document.createElement('div'); copy.className = 'settings-item-copy'; const title = document.createElement('strong'); title.textContent = notification.preview || 'إشعار جديد'; const meta = document.createElement('small'); meta.textContent = `${notification.readAt ? 'مقروء' : 'غير مقروء'}${notification.createdAt ? ` · ${new Date(notification.createdAt).toLocaleString('ar-EG')}` : ''}`; copy.append(title,meta); row.append(copy);
    if (!notification.readAt) { const button = document.createElement('button'); button.type = 'button'; button.className = 'settings-secondary'; button.textContent = 'قراءة'; button.addEventListener('click', async () => { try { await api(`/api/notifications/${encodeURIComponent(notification.id)}/read`, { method: 'PATCH', headers: authHeaders() }); await loadSettingsNotifications(); setSettingsStatus('تم تحديث الإشعار.'); } catch (e) { setSettingsStatus(e.message, true); } }); row.append(button); }
    list.append(row);
  }
}
async function loadSettingsSessions() {
  const list = $('settingsSessions'); list.replaceChildren();
  if (!token) { list.innerHTML = '<p class="settings-empty">سجّل الدخول لعرض الجلسات.</p>'; return; }
  const data = await api('/api/auth/sessions', { headers: authHeaders() });
  if (!data.sessions.length) { list.innerHTML = '<p class="settings-empty">لا توجد جلسات نشطة.</p>'; return; }
  for (const session of data.sessions) {
    const row = document.createElement('article'); row.className = 'settings-item'; const copy = document.createElement('div'); copy.className = 'settings-item-copy';
    const title = document.createElement('strong'); title.textContent = session.current ? 'هذا الجهاز · الجلسة الحالية' : 'جلسة على جهاز آخر'; const meta = document.createElement('small'); meta.textContent = `${session.userAgent || 'متصفح غير معروف'}${session.createdAt ? ` · ${new Date(session.createdAt).toLocaleString('ar-EG')}` : ''}`; copy.append(title,meta); row.append(copy);
    if (!session.current) { const button = document.createElement('button'); button.type = 'button'; button.className = 'settings-danger small-danger'; button.textContent = 'إلغاء'; button.addEventListener('click', async () => { try { await api(`/api/auth/sessions/${encodeURIComponent(session.id)}`, { method: 'DELETE', headers: authHeaders() }); await loadSettingsSessions(); setSettingsStatus('تم إلغاء الجلسة.'); } catch (e) { setSettingsStatus(e.message, true); } }); row.append(button); }
    list.append(row);
  }
}
function formatBytes(bytes) { const value = Math.max(0, Number(bytes) || 0); if (value < 1024) return `${value} بايت`; const units = ['KB','MB','GB','TB']; let n = value / 1024, i = 0; while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; } return `${n.toLocaleString('ar-EG', { maximumFractionDigits: 1 })} ${units[i]}`; }
async function loadStorageUsage() {
  if (!token) throw new Error('سجّل الدخول لعرض مساحة التخزين.');
  const [data, fileData] = await Promise.all([api('/api/account/storage', { headers: authHeaders() }), api('/api/account/storage/files', { headers: authHeaders() })]);
  $('storageUsed').textContent = formatBytes(data.usedBytes); $('storageQuotaLabel').textContent = `من ${formatBytes(data.quotaBytes)}`;
  $('storageFiles').textContent = `المرفقات: ${Number(data.files) || 0}`; $('storageRemaining').textContent = `المتبقي: ${formatBytes(data.remainingBytes)}`;
  $('storageMeterFill').style.width = `${Math.max(0, Math.min(100, Number(data.usagePercent) || 0))}%`; $('storageMeter').setAttribute('aria-valuenow', String(Math.max(0, Math.min(100, Number(data.usagePercent) || 0)))); $('storageMeter').dataset.warning = String((Number(data.usagePercent) || 0) >= 80);
  const list = $('settingsStorageFiles'); list.replaceChildren();
  if (!fileData.files?.length) { const empty = document.createElement('p'); empty.className = 'settings-empty'; empty.textContent = 'مفيش ملفات مرفوعة حاليًا.'; list.append(empty); return; }
  for (const file of fileData.files) { const row = document.createElement('article'); row.className = 'settings-item'; const copy = document.createElement('div'); copy.className = 'settings-item-copy'; const title = document.createElement('strong'); title.textContent = file.originalName || 'ملف بدون اسم'; const meta = document.createElement('small'); meta.textContent = `${formatBytes(file.size)} · ${file.mimeType || 'ملف'}${file.createdAt ? ` · ${new Date(file.createdAt).toLocaleDateString('ar-EG')}` : ''}`; copy.append(title,meta); const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'settings-danger small-danger'; remove.textContent = 'حذف'; remove.addEventListener('click', async () => { if (!window.confirm(`متأكد إنك عايز تحذف «${file.originalName || 'الملف'}»؟ هيتم حذف المرفق من الرسالة كمان.`)) return; remove.disabled = true; try { await api(`/api/account/storage/files/${encodeURIComponent(file.id)}`, { method: 'DELETE', headers: authHeaders() }); await loadStorageUsage(); setSettingsStatus('تم حذف الملف وتحديث مساحة التخزين.'); showToast('تم حذف الملف.'); } catch (e) { remove.disabled = false; setSettingsStatus(e.message || 'تعذر حذف الملف.', true); } }); row.append(copy,remove); list.append(row); }
}
async function compressAvatarImage(file) {
  if (!window.createImageBitmap || !document.createElement('canvas').toBlob) { if (file.size > 1024 * 1024) throw new Error('الصورة أكبر من 1 ميجابايت والمتصفح لا يدعم تصغيرها تلقائيًا.'); return file; }
  const bitmap = await createImageBitmap(file);
  try { const scale = Math.min(1, 512 / Math.max(bitmap.width, bitmap.height)); const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale)); const context = canvas.getContext('2d', { alpha: false }); if (!context) throw new Error('تعذر تجهيز الصورة.'); context.fillStyle = '#ffffff'; context.fillRect(0,0,canvas.width,canvas.height); context.drawImage(bitmap,0,0,canvas.width,canvas.height); const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.84)); if (!blob) throw new Error('تعذر ضغط الصورة.'); if (blob.size > 1024 * 1024) throw new Error('الصورة بعد الضغط ما زالت أكبر من 1 ميجابايت. اختار صورة أصغر.'); return new File([blob], 'profile-avatar.jpg', { type: 'image/jpeg', lastModified: Date.now() }); } finally { bitmap.close?.(); }
}
async function openSettings() {
  readWebPrefs(); switchSettingsTab('general'); setSettingsStatus('إعداداتك تحت سيطرتك.');
  $('profileNameInput').value = currentUser?.name || ''; $('profileEmailReadonly').value = currentUser?.email || ''; $('profilePreviewName').textContent = currentUser?.name || 'اسمك في وصل'; paintProfileImage();
  $('settingsDialog').showModal();
  if (!token) { setSettingsStatus('سجّل الدخول لإدارة إعدادات الحساب.', true); return; }
  try { await Promise.all([loadPrivacySettings(), loadSettingsNotifications(), loadSettingsSessions(), loadStorageUsage()]); }
  catch (error) { setSettingsStatus(error.message || 'تعذر تحميل بعض الإعدادات.', true); }
}
$('accountBtn').addEventListener('click', openSettings);
$('closeSettings').addEventListener('click', () => $('settingsDialog').close());
$('settingsDone').addEventListener('click', () => $('settingsDialog').close());
$('settingsDialog').addEventListener('click', event => { if (event.target === $('settingsDialog')) $('settingsDialog').close(); });
document.querySelectorAll('[data-settings-tab]').forEach(button => button.addEventListener('click', async () => {
  switchSettingsTab(button.dataset.settingsTab);
  try { if (button.dataset.settingsTab === 'profile') { $('profileNameInput').value = currentUser?.name || ''; $('profileEmailReadonly').value = currentUser?.email || ''; $('profilePreviewName').textContent = currentUser?.name || 'اسمك في وصل'; paintProfileImage(); } if (button.dataset.settingsTab === 'privacy') await loadPrivacySettings(); if (button.dataset.settingsTab === 'notifications') await loadSettingsNotifications(); if (button.dataset.settingsTab === 'sessions') await loadSettingsSessions(); if (button.dataset.settingsTab === 'storage') await loadStorageUsage(); }
  catch (error) { setSettingsStatus(error.message || 'تعذر تحميل الإعدادات.', true); }
}));
$('prefDark').addEventListener('change', () => setTheme($('prefDark').checked));
$('accentColor').addEventListener('change', () => applyAccent($('accentColor').value, true));
$('profileNameInput').addEventListener('input', () => { $('profilePreviewName').textContent = $('profileNameInput').value.trim() || 'اسمك في وصل'; });
$('profileImageInput').addEventListener('change', async () => { const file = $('profileImageInput').files?.[0]; if (!file) return; if (!token) { setSettingsStatus('سجّل الدخول قبل رفع صورة الحساب.', true); $('profileImageInput').value = ''; return; } if (!['image/jpeg','image/png','image/webp'].includes(file.type)) { showToast('اختار صورة PNG أو JPG أو WebP.'); $('profileImageInput').value = ''; return; } try { setSettingsStatus('بنجهز الصورة ونقلل حجمها…'); const optimized = await compressAvatarImage(file); const form = new FormData(); form.append('avatar', optimized); const data = await api('/api/account/avatar', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form }); currentUser = { ...currentUser, ...data.user }; remoteAvatarCache.delete(currentUser.avatarUrl); try { localStorage.removeItem(PROFILE_IMAGE_KEY); } catch {} await paintProfileImage(); setSettingsStatus(`تم تحديث الصورة. الحجم بعد التجهيز: ${formatBytes(optimized.size)}.`); showToast('تم تحديث صورة الحساب.'); } catch (error) { setSettingsStatus(error.message || 'تعذر رفع صورة الحساب.', true); } finally { $('profileImageInput').value = ''; } });
$('removeProfileImage').addEventListener('click', async () => { if (!token) { setSettingsStatus('سجّل الدخول أولًا.', true); return; } try { const data = await api('/api/account/avatar', { method: 'DELETE', headers: authHeaders() }); currentUser = { ...currentUser, ...data.user }; remoteAvatarCache.delete(currentUser.avatarUrl); try { localStorage.removeItem(PROFILE_IMAGE_KEY); } catch {} await paintProfileImage(); setSettingsStatus('تمت إزالة صورة الحساب من الخادم.'); } catch (error) { setSettingsStatus(error.message || 'تعذر إزالة الصورة.', true); } });
$('saveProfileSettings').addEventListener('click', async () => { if (!token || settingsBusy) { if (!token) setSettingsStatus('سجّل الدخول أولًا.', true); return; } const name = $('profileNameInput').value.trim().replace(/\s+/g, ' '); if (name.length < 2 || name.length > 40) { setSettingsStatus('الاسم يجب أن يكون بين حرفين و40 حرفًا.', true); return; } settingsBusy = true; $('saveProfileSettings').disabled = true; try { const data = await api('/api/account/profile', { method: 'PATCH', headers: authHeaders(), body: JSON.stringify({ name }) }); currentUser = { ...currentUser, ...data.user }; $('profileName').textContent = currentUser.name; $('profilePreviewName').textContent = currentUser.name; paintProfileImage(); await loadConversations(); setSettingsStatus('تم تحديث اسم الملف الشخصي على الحساب.'); showToast('تم تحديث ملفك الشخصي.'); } catch (error) { setSettingsStatus(error.message || 'تعذر حفظ الملف الشخصي.', true); } finally { settingsBusy = false; $('saveProfileSettings').disabled = false; } });
$('saveGeneralSettings').addEventListener('click', async () => {
  webPrefs = { compact: $('prefCompact').checked, enterToSend: $('prefEnter').checked, messageSound: $('prefSound').checked, desktopNotifications: $('prefDesktop').checked };
  if (webPrefs.desktopNotifications && 'Notification' in window && Notification.permission === 'default') { try { await Notification.requestPermission(); } catch {} }
  if (!('Notification' in window) || Notification.permission !== 'granted') { webPrefs.desktopNotifications = false; $('prefDesktop').checked = false; }
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(webPrefs)); } catch {}
  document.body.classList.toggle('compact-chats', webPrefs.compact); applyAccent($('accentColor').value, true); $('desktopPermissionNote').textContent = !('Notification' in window) ? 'المتصفح لا يدعم إشعارات سطح المكتب.' : `حالة إذن المتصفح: ${Notification.permission === 'granted' ? 'مسموح' : Notification.permission === 'denied' ? 'مرفوض' : 'لم يُطلب بعد'}.`;
  setSettingsStatus('تم حفظ تفضيلات الموقع على هذا الجهاز.'); showToast('تم حفظ تفضيلات الموقع.');
});
$('resetGeneralSettings').addEventListener('click', () => { webPrefs = { ...defaultPrefs }; $('prefCompact').checked = false; $('prefEnter').checked = true; $('prefSound').checked = false; $('prefDesktop').checked = false; setTheme(false); try { localStorage.setItem(PREFS_KEY, JSON.stringify(webPrefs)); } catch {} document.body.classList.remove('compact-chats'); setSettingsStatus('تمت استعادة الإعدادات الافتراضية.'); });
$('savePrivacySettings').addEventListener('click', async () => {
  if (settingsBusy) return; settingsBusy = true; $('savePrivacySettings').disabled = true;
  try { await api('/api/account/privacy', { method: 'PATCH', headers: authHeaders(), body: JSON.stringify({ showLastSeen: $('privacyLastSeen').value, showOnlineStatus: $('privacyOnline').value, notificationsEnabled: $('privacyNotifications').checked }) }); setSettingsStatus('تم حفظ إعدادات الخصوصية على الحساب.'); showToast('تم حفظ إعدادات الخصوصية.'); }
  catch (error) { setSettingsStatus(error.message || 'تعذر حفظ الخصوصية.', true); }
  finally { settingsBusy = false; $('savePrivacySettings').disabled = false; }
});
$('readAllNotifications').addEventListener('click', async () => { try { await api('/api/notifications/read-all', { method: 'POST', headers: authHeaders() }); await loadSettingsNotifications(); setSettingsStatus('تم وضع كل الإشعارات كمقروءة.'); } catch (e) { setSettingsStatus(e.message, true); } });
$('refreshSessions').addEventListener('click', async () => { try { await loadSettingsSessions(); setSettingsStatus('تم تحديث قائمة الجلسات.'); } catch (e) { setSettingsStatus(e.message, true); } });
$('refreshStorage').addEventListener('click', async () => { try { await loadStorageUsage(); setSettingsStatus('تم تحديث مساحة التخزين.'); } catch (e) { setSettingsStatus(e.message, true); } });
$('revokeOtherSessions').addEventListener('click', async () => { if (!window.confirm('تسجيل الخروج من كل الأجهزة الأخرى؟')) return; try { const result = await api('/api/auth/sessions/revoke-others', { method: 'POST', headers: authHeaders() }); await loadSettingsSessions(); setSettingsStatus(`تم إلغاء ${result.revokedCount} جلسة أخرى.`); } catch (e) { setSettingsStatus(e.message, true); } });
$('logoutBtn').addEventListener('click', async () => { try { await api('/api/auth/logout', { method: 'POST', headers: authHeaders() }); } catch {} logout(); });
$('messageForm').addEventListener('submit', async event => {
  event.preventDefault(); const input = $('messageInput'); const text = input.value.trim();
  if (!text) { showToast('اكتب رسالة قبل الإرسال'); input.focus(); return; }
  if (text.length > MAX_MESSAGE_LENGTH) { showToast('الرسالة أطول من الحد المسموح'); return; }
  if (!token) { showAuth('سجّل الدخول لإرسال الرسائل.'); return; }
  const chat = chats.find(item => item.id === activeId); if (!chat) { showToast('أنشئ محادثة أو اختر واحدة أولًا'); return; }
  const sendButton = $('messageForm').querySelector('[type="submit"]'); sendButton.disabled = true;
  try {
    const data = await api(`/api/conversations/${encodeURIComponent(chat.id)}/messages`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ text, replyToMessageId: pendingReplyId, forwardedFromMessageId: pendingForwardId }) });
    pendingReplyId = null; pendingForwardId = null; input.placeholder = 'اكتب رسالتك هنا…';
    if (!seenMessageIds.has(data.message.id)) { seenMessageIds.add(data.message.id); chat.messages.push(normalizeMessage(data.message)); }
    input.value = ''; input.style.height = 'auto'; renderList(); renderChat(); input.focus();
  } catch (error) { showToast(error.message); }
  finally { sendButton.disabled = false; }
});
$('messageInput').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && webPrefs.enterToSend !== false) { event.preventDefault(); $('messageForm').requestSubmit(); } });
$('messageInput').addEventListener('input', event => {
  event.target.style.height = 'auto'; event.target.style.height = `${Math.min(event.target.scrollHeight, 120)}px`;
  if (socket?.connected && activeId && event.target.value.trim()) {
    socket.emit('typing:start', { conversationId: activeId });
    clearTimeout(typingStopTimer); typingStopTimer = setTimeout(() => socket?.emit('typing:stop', { conversationId: activeId }), 1200);
  } else if (socket?.connected && activeId) socket.emit('typing:stop', { conversationId: activeId });
});
$('messageInput').addEventListener('blur', () => { clearTimeout(typingStopTimer); if (socket?.connected && activeId) socket.emit('typing:stop', { conversationId: activeId }); });
$('searchInput').addEventListener('input', renderList);
$('newChatBtn').addEventListener('click', () => { if (!token) return showAuth(); $('newChatDialog').showModal(); $('newName').focus(); });
$('newGroupBtn').addEventListener('click', () => { if (!token) return showAuth(); $('newGroupDialog').showModal(); $('groupTitle').focus(); });
$('closeGroupDialog').addEventListener('click', () => $('newGroupDialog').close());
$('newGroupDialog').addEventListener('click', event => { if (event.target === $('newGroupDialog')) $('newGroupDialog').close(); });
$('newGroupForm').addEventListener('submit', async event => {
  event.preventDefault(); const title = $('groupTitle').value.trim();
  const memberEmails = $('groupMembers').value.split(/[\n,;]+/).map(value => value.trim().toLowerCase()).filter(Boolean);
  $('groupError').textContent = '';
  if (title.length < 2) { $('groupError').textContent = 'اسم المجموعة يجب أن يتكون من حرفين على الأقل.'; return; }
  if (!memberEmails.length) { $('groupError').textContent = 'أدخل بريدًا إلكترونيًا واحدًا على الأقل.'; return; }
  try {
    const data = await api('/api/groups', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ title, memberEmails }) });
    $('newGroupDialog').close(); $('newGroupForm').reset(); await loadConversations(); await openChat(data.conversation.id); showToast('تم إنشاء المجموعة بنجاح.');
  } catch (error) { $('groupError').textContent = error.message; }
});
$('closeDialog').addEventListener('click', () => $('newChatDialog').close());
$('newChatDialog').addEventListener('click', event => { if (event.target === $('newChatDialog')) $('newChatDialog').close(); });
$('newChatForm').addEventListener('submit', async event => {
  event.preventDefault(); const recipientEmail = $('newName').value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail)) { $('nameError').textContent = 'أدخل بريدًا إلكترونيًا صحيحًا.'; return; }
  $('nameError').textContent = '';
  try {
    const data = await api('/api/conversations', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ recipientEmail }) });
    const existing = chats.find(c => c.id === data.conversation.id);
    if (!existing) {
      const otherId = data.conversation.memberIds.find(id => id !== currentUser.id);
      const chat = { id: data.conversation.id, title: data.conversation.title, memberIds: data.conversation.memberIds, name: recipientEmail, online: false, unread: 0, color: colors[chats.length % colors.length], messages: [] };
      chats.unshift(chat);
    }
    $('newChatDialog').close(); $('newChatForm').reset(); await loadConversations(); await openChat(data.conversation.id); showToast('تم فتح المحادثة.');
  } catch (error) { $('nameError').textContent = error.message; }
});
$('newName').addEventListener('input', () => { $('nameError').textContent = ''; });
$('backBtn').addEventListener('click', () => document.querySelector('.app-shell').classList.remove('chat-open'));
$('infoBtn').addEventListener('click', async () => {
  const chat = chats.find(c => c.id === activeId);
  if (!chat) { showToast('لا توجد محادثة محددة'); return; }
  if (chat.type !== 'group') { showToast(`${chat.name} · ${chat.messages.length} رسالة`); return; }
  const role = chat.memberRoles?.[currentUser?.id] || 'member';
  if (!['owner', 'admin'].includes(role)) { showToast(`${chat.name} · ${chat.memberIds.length} أعضاء · لا تملك صلاحية الإدارة`); return; }
  const action = window.prompt('إدارة المجموعة:\n1 تغيير الاسم\n2 إضافة أعضاء بالبريد\n3 إزالة عضو بالبريد\n4 تعيين/إلغاء مشرف (للمالك فقط)\nاكتب رقم الاختيار');
  if (!action) return;
  try {
    if (action.trim() === '1') {
      const title = window.prompt('اسم المجموعة الجديد:', chat.title || chat.name);
      if (!title) return;
      await api(`/api/groups/${encodeURIComponent(chat.id)}`, { method: 'PATCH', headers: authHeaders(), body: JSON.stringify({ title }) });
      await loadConversations(); showToast('تم تحديث اسم المجموعة.');
    } else if (action.trim() === '2') {
      const raw = window.prompt('اكتب البريد الإلكتروني لكل عضو، وافصل بينها بفاصلة أو سطر جديد:');
      if (!raw) return;
      const memberEmails = raw.split(/[\n,;]+/).map(x => x.trim().toLowerCase()).filter(Boolean);
      const result = await api(`/api/groups/${encodeURIComponent(chat.id)}/members`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ memberEmails }) });
      await loadConversations(); showToast(`تمت إضافة ${result.addedCount} عضو.`);
    } else if (action.trim() === '3') {
      const members = chat.members.filter(m => m.id !== currentUser.id);
      const choices = members.map(m => `${m.name} <${m.email}>`).join('\n');
      const email = window.prompt(`اكتب بريد العضو المراد إزالته:\n${choices}`);
      if (!email) return;
      const target = members.find(m => m.email.toLowerCase() === email.trim().toLowerCase());
      if (!target) { showToast('لم نعثر على عضو بهذا البريد داخل المجموعة.'); return; }
      await api(`/api/groups/${encodeURIComponent(chat.id)}/members/${encodeURIComponent(target.id)}`, { method: 'DELETE', headers: authHeaders() });
      await loadConversations(); showToast('تمت إزالة العضو من المجموعة.');
    } else if (action.trim() === '4') {
      if (role !== 'owner') { showToast('تغيير الأدوار متاح لمالك المجموعة فقط.'); return; }
      const candidates = chat.members.filter(m => m.id !== currentUser.id);
      const email = window.prompt(`اكتب بريد العضو لتغيير دوره:\n${candidates.map(m => `${m.name} <${m.email}>`).join('\n')}`);
      if (!email) return;
      const target = candidates.find(m => m.email.toLowerCase() === email.trim().toLowerCase());
      if (!target) { showToast('لم نعثر على عضو بهذا البريد داخل المجموعة.'); return; }
      const currentRole = chat.memberRoles?.[target.id] || 'member';
      const nextRole = window.prompt('اكتب admin لتعيينه مشرفًا أو member لإعادته عضوًا:', currentRole === 'admin' ? 'member' : 'admin');
      if (!nextRole) return;
      const normalizedRole = nextRole.trim().toLowerCase();
      if (!['admin', 'member'].includes(normalizedRole)) { showToast('الدور يجب أن يكون admin أو member.'); return; }
      await api(`/api/groups/${encodeURIComponent(chat.id)}/members/${encodeURIComponent(target.id)}/role`, { method: 'PATCH', headers: authHeaders(), body: JSON.stringify({ role: normalizedRole }) });
      await loadConversations(); showToast('تم تحديث دور العضو.');
    } else showToast('اختيار غير صحيح.');
  } catch (error) { showToast(error.message); }
});
$('emojiBtn').addEventListener('click', () => { const input = $('messageInput'); const start = input.selectionStart ?? input.value.length; const end = input.selectionEnd ?? start; input.setRangeText('😊', start, end, 'end'); input.dispatchEvent(new Event('input', { bubbles: true })); input.focus(); });
$('attachBtn').addEventListener('click', () => $('fileInput').click());
async function downloadAttachment(attachment) {
  try {
    const response = await fetch(`/api/attachments/${encodeURIComponent(attachment.id)}/download`, { headers: authHeaders() });
    if (!response.ok) { let data = {}; try { data = await response.json(); } catch {} throw new Error(data.error || 'تعذر تنزيل الملف.'); }
    const blob = await response.blob(); const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = attachment.originalName || 'attachment'; document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) { showToast(error.message); }
}
$('fileInput').addEventListener('change', async event => {
  const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
  const chat = chats.find(item => item.id === activeId);
  if (!token || !chat) { showToast('سجّل الدخول وافتح محادثة قبل إرفاق ملف.'); return; }
  if (file.size > MAX_FILE_SIZE) { showToast('الحد الأقصى لحجم الملف هو 5 ميجابايت'); return; }
  const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf', 'text/plain'];
  if (!allowed.includes(file.type)) { showToast('النوع غير مدعوم. استخدم صورة أو PDF أو TXT.'); return; }
  const form = new FormData(); form.append('file', file); const button = $('attachBtn'); button.disabled = true;
  try {
    const response = await fetch(`/api/conversations/${encodeURIComponent(chat.id)}/attachments`, { method: 'POST', headers: authHeaders(), body: form });
    let data = {}; try { data = await response.json(); } catch {} if (!response.ok) throw new Error(data.error || 'تعذر رفع الملف.');
    if (!seenMessageIds.has(data.message.id)) { seenMessageIds.add(data.message.id); chat.messages.push(normalizeMessage(data.message)); }
    renderChat(); renderList(); showToast('تم إرسال الملف داخل المحادثة.');
  } catch (error) { showToast(error.message); } finally { button.disabled = false; }
});
function setTheme(dark, persist = true) {
  document.body.classList.toggle('dark', dark); const themeColor = document.querySelector('meta[name="theme-color"]');
  if (themeColor) themeColor.setAttribute('content', dark ? '#0d1426' : '#101b35'); $('themeBtn').textContent = dark ? '☀' : '☾';
  $('themeBtn').setAttribute('aria-label', dark ? 'تفعيل الوضع الفاتح' : 'تفعيل الوضع الداكن');
  if ($('prefDark')) $('prefDark').checked = dark;
  if (persist) { try { localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light'); } catch {} }
}
let savedTheme = 'light'; try { savedTheme = localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light'; } catch {}
setTheme(savedTheme === 'dark', false);
try { const savedPrefs = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}'); webPrefs = { ...defaultPrefs, ...savedPrefs }; } catch { webPrefs = { ...defaultPrefs }; }
document.body.classList.toggle('compact-chats', webPrefs.compact);
$('themeBtn').addEventListener('click', () => setTheme(!document.body.classList.contains('dark')));
document.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); $('searchInput').focus(); if (mobile()) document.querySelector('.app-shell').classList.remove('chat-open'); } });
initializeSession().catch(error => { console.error('Wasl initialization failed:', error); showAuth('تعذر الاتصال بالخادم. تأكد من تشغيل الخادم ثم أعد المحاولة.'); });
