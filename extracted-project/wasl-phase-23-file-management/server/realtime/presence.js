'use strict';

/** In-process presence registry. Online state is derived from active sockets, never from client claims. */
function createPresenceRegistry(clock = () => new Date().toISOString()) {
  const socketsByUser = new Map();
  const lastSeenByUser = new Map();

  return {
    connect(userId, socketId) {
      let sockets = socketsByUser.get(userId);
      const wasOnline = Boolean(sockets?.size);
      if (!sockets) { sockets = new Set(); socketsByUser.set(userId, sockets); }
      sockets.add(socketId);
      return { online: true, becameOnline: !wasOnline, socketCount: sockets.size, lastSeenAt: lastSeenByUser.get(userId) || null };
    },
    disconnect(userId, socketId) {
      const sockets = socketsByUser.get(userId);
      if (!sockets) return { online: false, wentOffline: false, lastSeenAt: lastSeenByUser.get(userId) || null };
      sockets.delete(socketId);
      if (sockets.size) return { online: true, wentOffline: false, socketCount: sockets.size, lastSeenAt: lastSeenByUser.get(userId) || null };
      socketsByUser.delete(userId);
      const lastSeenAt = clock();
      lastSeenByUser.set(userId, lastSeenAt);
      return { online: false, wentOffline: true, socketCount: 0, lastSeenAt };
    },
    rememberLastSeen(userId, lastSeenAt) { if (lastSeenAt && !socketsByUser.has(userId)) lastSeenByUser.set(userId, lastSeenAt); },
    isOnline(userId) { return Boolean(socketsByUser.get(userId)?.size); },
    snapshot(userIds) {
      const result = {};
      for (const userId of userIds) result[userId] = { online: this.isOnline(userId), lastSeenAt: lastSeenByUser.get(userId) || null };
      return result;
    },
    onlineUserIds() { return [...socketsByUser.keys()]; }
  };
}

module.exports = { createPresenceRegistry };
