'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const restoreScript = path.join(root, 'scripts', 'restore-postgres.sh');

function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wasl-restore-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stamp = options.stamp || '20261028T120000Z';
  const dbName = `wasl-${stamp}.dump`;
  const uploadsName = `wasl-${stamp}.uploads.tar.gz`;
  const manifestName = `wasl-${stamp}.sha256`;
  fs.writeFileSync(path.join(dir, dbName), 'dummy database dump');
  fs.writeFileSync(path.join(dir, uploadsName), 'dummy uploads archive');
  const dbHash = options.badDbHash ? '0'.repeat(64) : require('node:crypto').createHash('sha256').update('dummy database dump').digest('hex');
  const uploadsHash = require('node:crypto').createHash('sha256').update('dummy uploads archive').digest('hex');
  fs.writeFileSync(path.join(dir, manifestName), `${dbHash}  ${dbName}\n${uploadsHash}  ${uploadsName}\n`);
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const marker = path.join(dir, 'pg_restore_called');
  fs.writeFileSync(path.join(bin, 'pg_restore'), `#!/bin/sh\nprintf called >> '${marker}'\nexit 0\n`, { mode: 0o755 });
  return { dir, stamp, dbName, uploadsName, manifestName, marker, bin };
}

function runRestore(f, overrides = {}) {
  return spawnSync('sh', [restoreScript], {
    cwd: f.dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${f.bin}:${process.env.PATH}`,
      DATABASE_URL: 'postgresql://test:test@127.0.0.1/test',
      BACKUP_FILE: path.join(f.dir, f.dbName),
      UPLOADS_BACKUP_FILE: path.join(f.dir, f.uploadsName),
      BACKUP_MANIFEST_FILE: path.join(f.dir, f.manifestName),
      UPLOAD_DIR: path.join(f.dir, 'uploads'),
      CONFIRM_RESTORE: 'YES',
      ...overrides,
    },
  });
}

test('restore aborts on checksum mismatch before invoking pg_restore', t => {
  const f = fixture(t, { badDbHash: true });
  const result = runRestore(f);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /FAILED|checksum/i);
  assert.equal(fs.existsSync(f.marker), false, 'database restore must not start for an invalid backup');
});

test('restore aborts when database and uploads backups are from different runs', t => {
  const f = fixture(t);
  const otherUploads = path.join(f.dir, 'wasl-20261028T120001Z.uploads.tar.gz');
  fs.writeFileSync(otherUploads, 'other uploads');
  const result = runRestore(f, { UPLOADS_BACKUP_FILE: otherUploads });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /timestamps do not match/);
  assert.equal(fs.existsSync(f.marker), false, 'database restore must not start for mixed backup sets');
});

test('restore replaces the uploads snapshot and rolls files back when pg_restore fails', t => {
  const f = fixture(t);
  const uploadsSource = path.join(f.dir, 'source-uploads');
  fs.mkdirSync(uploadsSource);
  fs.writeFileSync(path.join(uploadsSource, 'new-attachment.bin'), 'new attachment');
  const archivePath = path.join(f.dir, f.uploadsName);
  const tar = spawnSync('tar', ['-czf', archivePath, '-C', uploadsSource, '.'], { encoding: 'utf8' });
  assert.equal(tar.status, 0, tar.stderr);
  const dbPath = path.join(f.dir, f.dbName);
  fs.writeFileSync(dbPath, 'dummy database dump');
  const crypto = require('node:crypto');
  const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  fs.writeFileSync(path.join(f.dir, f.manifestName), `${hash(dbPath)}  ${f.dbName}\n${hash(archivePath)}  ${f.uploadsName}\n`);

  // The preflight --list succeeds, but the destructive restore command fails.
  fs.writeFileSync(path.join(f.bin, 'pg_restore'), `#!/bin/sh\nfor arg in "$@"; do [ "$arg" = "--list" ] && exit 0; done\nexit 42\n`, { mode: 0o755 });
  const uploadDir = path.join(f.dir, 'uploads');
  fs.mkdirSync(uploadDir);
  fs.writeFileSync(path.join(uploadDir, 'old-attachment.bin'), 'old attachment');
  const result = runRestore(f, { UPLOAD_DIR: uploadDir });
  assert.notEqual(result.status, 0, 'restore should report pg_restore failure');
  assert.equal(fs.readFileSync(path.join(uploadDir, 'old-attachment.bin'), 'utf8'), 'old attachment');
  assert.equal(fs.existsSync(path.join(uploadDir, 'new-attachment.bin')), false);
});
