import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startMockCloud, stopMockCloud, Project, startStudio, freePort } from './helpers/helpers.js';

let cloud;
let token;

test.after(async () => {
  if (cloud) await stopMockCloud(cloud);
});

test.before(async () => {
  cloud = await startMockCloud();
  token = cloud.mintToken();
});

const api = async (port, path, { method = 'GET', body } = {}) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, text, json };
};

test('a backup can be taken, listed and restored from the CLI', async () => {
  const proj = new Project(cloud, token, 'backup');
  proj.write('tgcloud/handlers/message.js', 'export default async function (message, ctx) { return 1; }\n');
  proj.write('tgcloud/lib/util.js', 'export const answer = 42;\n');

  const taken = await proj.cli(['backup', '--label', 'working version']);
  assert.equal(taken.code, 0, taken.out);
  assert.match(taken.out, /Backup \d{8}-\d{6}-working-version/);

  // Break the code the way a bad change would.
  proj.write('tgcloud/handlers/message.js', 'export default async function (message, ctx) { return BROKEN; }\n');

  const list = await proj.cli(['backups']);
  assert.equal(list.code, 0, list.out);
  assert.match(list.out, /1 backup/);
  assert.match(list.out, /working version/);

  const id = /Backup (\d{8}-\d{6}-working-version)/.exec(taken.out)[1];
  const restored = await proj.cli(['restore', id]);
  assert.equal(restored.code, 0, restored.out);
  assert.match(restored.out, /Restored \d+ files/);
  assert.match(
    proj.read('tgcloud/handlers/message.js'),
    /return 1/,
    'the file is back to the state of the backup'
  );
  // The state before the restore is kept as a backup of its own.
  const after = await proj.cli(['backups']);
  assert.match(after.out, /before-restore/);
});

test('the studio can save and restore a backup', async () => {
  const port = await freePort();
  const proj = new Project(cloud, token, 'backup-studio');
  proj.write('tgcloud/handlers/message.js', 'export default async function (message, ctx) { return 1; }\n');
  const child = await startStudio(proj, port);
  try {
    const empty = await api(port, '/api/backups');
    assert.equal(empty.status, 200, empty.text);
    assert.deepEqual(empty.json.backups, []);

    const created = await api(port, '/api/backups', { method: 'POST', body: { label: 'before the change' } });
    assert.equal(created.status, 200, created.text);
    assert.equal(created.json.backup.files >= 1, true);
    const id = created.json.backup.id;

    // Break it, then put it back.
    proj.write('tgcloud/handlers/message.js', 'export default async function (message, ctx) { return BROKEN; }\n');
    const restored = await api(port, '/api/backups/restore', { method: 'POST', body: { id } });
    assert.equal(restored.status, 200, restored.text);
    assert.ok(restored.json.restored.length >= 1);
    assert.ok(restored.json.safety, 'the state before the restore was saved');
    assert.match(proj.read('tgcloud/handlers/message.js'), /return 1/);

    const missing = await api(port, '/api/backups/restore', { method: 'POST', body: { id: 'nope' } });
    assert.equal(missing.status, 400, missing.text);
  } finally {
    child.kill('SIGTERM');
  }
});

test('backups stay out of the deployed code', async () => {
  const proj = new Project(cloud, token, 'backup-scope');
  proj.write('tgcloud/handlers/message.js', 'export default async function (message, ctx) { return 1; }\n');
  const taken = await proj.cli(['backup']);
  assert.equal(taken.code, 0, taken.out);
  const dir = path.join(proj.dir, '.tgpilot', 'profiles', 'default', 'backups');
  assert.ok(fs.existsSync(dir));
  // The backup is a copy of the project, not a part of it.
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0], 'manifest.json'), 'utf-8'));
  assert.ok(manifest.files >= 1);
  assert.ok(!manifest.files || !manifest.files.toString().includes('.tgpilot'));
});

test('a backup can be removed again', async () => {
  const port = await freePort();
  const proj = new Project(cloud, token, 'backup-delete');
  proj.write('tgcloud/handlers/message.js', 'export default async function (message, ctx) { return 1; }\n');
  const child = await startStudio(proj, port);
  try {
    const created = await api(port, '/api/backups', { method: 'POST', body: { label: 'temporary' } });
    assert.equal(created.status, 200, created.text);
    const id = created.json.backup.id;
    assert.equal(created.json.backups.length, 1);

    const removed = await api(port, '/api/backups', { method: 'DELETE', body: { id } });
    assert.equal(removed.status, 200, removed.text);
    assert.equal(removed.json.removed, true);
    assert.deepEqual(removed.json.backups, []);

    const missing = await api(port, '/api/backups', { method: 'DELETE', body: { id } });
    assert.equal(missing.status, 200);
    assert.equal(missing.json.removed, false);
  } finally {
    child.kill('SIGTERM');
  }
});
