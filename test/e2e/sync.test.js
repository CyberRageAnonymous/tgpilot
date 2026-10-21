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
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, text, json };
};

test('a file that appeared on the bot lands in the folder', async () => {
  const port = await freePort();
  const proj = new Project(cloud, token, 'sync');
  proj.write('tgcloud/handlers/message.js', 'export default async function (message, ctx) { return 1; }\n');
  const child = await startStudio(proj, port);
  try {
    // Somebody changes the bot from a phone: a new module appears there.
    const bots = cloud.bots;
    const bot = [...bots.values()][0];
    bot.modules.set('handlers/callback_query', 'export default async function (cb, ctx) { return 2; }\n');
    bot.revision += 1;

    const preview = await api(port, '/api/sync/preview', { method: 'POST', body: {} });
    assert.equal(preview.status, 200, preview.text);
    assert.ok(preview.json.preview.added.includes('tgcloud/handlers/callback_query.js'), preview.text);
    assert.equal(proj.exists('tgcloud/handlers/callback_query.js'), false, 'nothing is written before the confirmation');

    const applied = await api(port, '/api/sync/apply', { method: 'POST', body: {} });
    assert.equal(applied.status, 200, applied.text);
    assert.equal(proj.exists('tgcloud/handlers/callback_query.js'), true, 'the new file is in the folder now');
    assert.match(proj.read('tgcloud/handlers/callback_query.js'), /return 2/);
    assert.ok(applied.json.safety, 'a backup was taken before the sync');
  } finally {
    child.kill('SIGTERM');
  }
});

test('a local file the bot never knew is left alone', async () => {
  const port = await freePort();
  const proj = new Project(cloud, token, 'sync-local');
  proj.write('tgcloud/handlers/message.js', 'export default async function (message, ctx) { return 1; }\n');
  proj.write('tgcloud/lib/helper.js', 'export const helper = true;\n');
  proj.write('notes.md', '# my notes\n');
  const child = await startStudio(proj, port);
  try {
    const applied = await api(port, '/api/sync/apply', { method: 'POST', body: {} });
    assert.equal(applied.status, 200, applied.text);
    assert.equal(proj.exists('tgcloud/lib/helper.js'), true, 'a local helper survives the sync');
    assert.equal(proj.exists('notes.md'), true, 'a local note survives the sync');
  } finally {
    child.kill('SIGTERM');
  }
});

test('the sync takes a backup that can be restored', async () => {
  const port = await freePort();
  const proj = new Project(cloud, token, 'sync-backup');
  proj.write('tgcloud/handlers/message.js', 'export default async function (message, ctx) { return 1; }\n');
  const child = await startStudio(proj, port);
  try {
    const applied = await api(port, '/api/sync/apply', { method: 'POST', body: {} });
    assert.equal(applied.status, 200, applied.text);
    const backupId = applied.json.safety?.id;
    assert.ok(backupId, 'the sync names its backup');

    const dir = path.join(proj.dir, '.tgpilot', 'backups', backupId, 'manifest.json');
    assert.ok(fs.existsSync(dir));
  } finally {
    child.kill('SIGTERM');
  }
});
