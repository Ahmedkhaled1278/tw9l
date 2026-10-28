'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('release container runs as a non-root user and has a health check', () => {
  const dockerfile = read('Dockerfile');
  assert.match(dockerfile, /^USER wasl$/m);
  assert.match(dockerfile, /HEALTHCHECK/);
  assert.match(dockerfile, /npm install --omit=dev/);
});

test('compose waits for healthy PostgreSQL and keeps uploads persistent', () => {
  const compose = read('docker-compose.yml');
  assert.match(compose, /condition: service_healthy/);
  assert.match(compose, /wasl-postgres:\/var\/lib\/postgresql\/data/);
  assert.match(compose, /wasl-uploads:\/app\/uploads/);
  assert.match(compose, /127\.0\.0\.1:3000:3000/);
  assert.match(compose, /\$\{POSTGRES_PASSWORD:\?Set POSTGRES_PASSWORD/);
});

test('restore script requires explicit confirmation before destructive restore', () => {
  const restore = read('scripts/restore-postgres.sh');
  assert.match(restore, /CONFIRM_RESTORE/);
  assert.match(restore, /pg_restore --clean/);
  assert.match(restore, /--exit-on-error/);
  assert.match(restore, /BACKUP_MANIFEST_FILE/);
  assert.match(restore, /sha256sum -c/);
  assert.match(restore, /timestamps do not match/);
});

test('smoke test verifies health and anonymous access denial', () => {
  const smoke = read('scripts/smoke.js');
  assert.match(smoke, /\/api\/health/);
  assert.match(smoke, /protectedResponse\.status !== 401/);
});

test('backup includes PostgreSQL data, uploaded files, and checksums', () => {
  const backup = read('scripts/backup-postgres.sh');
  assert.match(backup, /pg_dump/);
  assert.match(backup, /tar -czf/);
  assert.match(backup, /sha256sum/);
  assert.match(backup, /UPLOAD_DIR/);
});

test('restore requires the matching uploads archive and rejects unsafe archive paths', () => {
  const restore = read('scripts/restore-postgres.sh');
  assert.match(restore, /UPLOADS_BACKUP_FILE/);
  assert.match(restore, /tar -tzf/);
  assert.match(restore, /Unsafe parent path/);
  assert.match(restore, /Unsupported link or special entry/);
  assert.match(restore, /--no-same-owner --no-same-permissions/);
  assert.match(restore, /mv "\$UPLOAD_DIR" "\$PREVIOUS_UPLOADS"/);
  assert.match(restore, /rollback_uploads/);
  assert.match(restore, /replaced from the matching snapshot/);
});
