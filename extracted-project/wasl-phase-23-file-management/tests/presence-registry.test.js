'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPresenceRegistry } = require('../server/realtime/presence');

test('presence stays online until the final device disconnects', () => {
  const presence = createPresenceRegistry(() => '2026-10-28T00:00:00.000Z');
  assert.equal(presence.connect('usr_a', 'socket-1').becameOnline, true);
  assert.equal(presence.connect('usr_a', 'socket-2').becameOnline, false);
  assert.equal(presence.disconnect('usr_a', 'socket-1').online, true);
  assert.equal(presence.isOnline('usr_a'), true);
  const final = presence.disconnect('usr_a', 'socket-2');
  assert.equal(final.wentOffline, true);
  assert.equal(final.lastSeenAt, '2026-10-28T00:00:00.000Z');
  assert.equal(presence.isOnline('usr_a'), false);
});

test('presence snapshots include offline last-seen values without exposing unknown users', () => {
  const presence = createPresenceRegistry(() => '2026-10-28T00:00:00.000Z');
  presence.connect('usr_a', 'socket-1');
  presence.disconnect('usr_a', 'socket-1');
  assert.deepEqual(presence.snapshot(['usr_a', 'usr_b']), {
    usr_a: { online: false, lastSeenAt: '2026-10-28T00:00:00.000Z' },
    usr_b: { online: false, lastSeenAt: null }
  });
});


test('disconnecting an unknown socket does not mark an active user offline', () => {
  const presence = createPresenceRegistry(() => '2026-10-28T00:00:00.000Z');
  presence.connect('usr_a', 'socket-1');
  const result = presence.disconnect('usr_a', 'unrelated-socket');
  assert.equal(result.online, true);
  assert.equal(result.wentOffline, false);
  assert.equal(presence.isOnline('usr_a'), true);
});
