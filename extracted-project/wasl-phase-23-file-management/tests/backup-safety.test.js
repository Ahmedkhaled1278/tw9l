'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const backupScript = path.join(root, 'scripts', 'backup-postgres.sh');

function fixture(t, { failTar = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wasl-backup-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  const uploads = path.join(dir, 'uploads');
  const backups = path.join(dir, 'backups');
  fs.mkdirSync(bin); fs.mkdirSync(uploads); fs.mkdirSync(backups);
  fs.writeFileSync(path.join(uploads, 'example.txt'), 'test upload');
  fs.writeFileSync(path.join(bin, 'date'), '#!/bin/sh\nprintf "20261028T120000Z\\n"\n', { mode: 0o755 });
  const dumpMarker = path.join(dir, 'pg_dump_called');
  fs.writeFileSync(path.join(bin, 'pg_dump'), `#!/bin/sh\nprintf called >> '${dumpMarker}'\nfor arg do case "$arg" in --file=*) out="${'${arg#--file=}'}";; esac; done\nprintf 'fake postgres dump\\n' > "$out"\n`, { mode: 0o755 });
  if (failTar) fs.writeFileSync(path.join(bin, 'tar'), '#!/bin/sh\necho simulated-tar-failure >&2\nexit 9\n', { mode: 0o755 });
  return { dir, bin, uploads, backups, dumpMarker };
}

function runBackup(f, extraEnv = {}) {
  return spawnSync('sh', [backupScript], {
    cwd: f.dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${f.bin}:${process.env.PATH}`,
      DATABASE_URL: 'postgresql://test:test@127.0.0.1/test',
      UPLOAD_DIR: f.uploads,
      BACKUP_DIR: f.backups,
      ...extraEnv,
    },
  });
}

test('backup publishes database, uploads and checksum manifest only after successful completion', t => {
  const f = fixture(t);
  const result = runBackup(f);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const names = fs.readdirSync(f.backups).sort();
  assert.deepEqual(names, [
    'wasl-20261028T120000Z.dump',
    'wasl-20261028T120000Z.sha256',
    'wasl-20261028T120000Z.uploads.tar.gz',
  ]);
  const manifest = fs.readFileSync(path.join(f.backups, 'wasl-20261028T120000Z.sha256'), 'utf8');
  assert.match(manifest, /wasl-20261028T120000Z\.dump/);
  assert.match(manifest, /wasl-20261028T120000Z\.uploads\.tar\.gz/);
  for (const name of names) assert.equal(fs.statSync(path.join(f.backups, name)).mode & 0o777, 0o600);
});

test('backup refuses to overwrite an existing recovery point', t => {
  const f = fixture(t);
  const existing = path.join(f.backups, 'wasl-20261028T120000Z.dump');
  fs.writeFileSync(existing, 'keep this original backup');
  const result = runBackup(f);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /refusing to overwrite/i);
  assert.equal(fs.readFileSync(existing, 'utf8'), 'keep this original backup');
  assert.equal(fs.existsSync(f.dumpMarker), false, 'must refuse before running pg_dump');
});

test('backup failure leaves no apparently complete or partial published backup set', t => {
  const f = fixture(t, { failTar: true });
  const result = runBackup(f);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /simulated-tar-failure/);
  assert.deepEqual(fs.readdirSync(f.backups), []);
});
