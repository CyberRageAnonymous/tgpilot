import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { startMockCloud, stopMockCloud, Project } from './helpers/helpers.js';

test.after(async () => {
  if (cloud) await stopMockCloud(cloud);
});

let cloud;
let token;
let proj;
let botOf;

test.before(async () => {
  cloud = await startMockCloud();
  token = cloud.mintToken();
  proj = new Project(cloud, token, 'lifecycle');
  botOf = () => cloud.bots.get([...cloud.bots.keys()][0]);
});

// A pure handler: no sdk imports, so the mock's mini-loader can execute it.
const HANDLER = `export default async function (message, ctx) {
  console.log('text is', message.text);
  return { echo: message.text };
}
`;

test('init scaffolds from the server templates', async () => {
  const r = await proj.cli(['init', '--no-git']);
  assert.equal(r.code, 0, r.out);
  assert.match(proj.read('tgcloud/schema.js'), /server-issued schema starter/);
  assert.match(proj.read('tgcloud/handlers/message.js'), /server-issued handler starter/);
  assert.ok(proj.exists('tgcloud/lib'));
  assert.ok(proj.exists('tgcloud.jsonc'));
  assert.match(proj.read('.gitignore'), /\.tgpilot\//);
  assert.ok(proj.exists(proj.statePath()));
  const state = proj.state();
  assert.ok(state.init_templates['tgcloud/schema.js']);
  assert.ok(state.init_templates['tgcloud/handlers/message.js']);
});

test('status before any sync warns about the snapshot', async () => {
  const r = await proj.cli(['status']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /no local snapshot yet/i);
});

test('first push deploys everything and writes the snapshot', async () => {
  proj.write('tgcloud/handlers/message.js', HANDLER);
  const r = await proj.cli(['push']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Deploying \d+ changes…/);
  assert.match(r.out, /Done in /);
  assert.equal(botOf().modules.get('handlers/message'), HANDLER);
  assert.ok(proj.exists(path.join(proj.snapshotPath(), 'handlers/message.js')));
  assert.ok(proj.exists(path.join(proj.snapshotPath(), 'schema.js')));
  assert.equal(proj.read(path.join(proj.snapshotPath(), 'handlers/message.js')), HANDLER);
  assert.equal(proj.state().last_known_revision, 1);
});

test('status is clean after a push', async () => {
  const r = await proj.cli(['status']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Everything matches the last deployed state\./);
});

test('migrate applies the pending database change with --yes', async () => {
  const r = await proj.cli(['migrate', '--yes']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /new column/);
  assert.match(r.out, /applied: 1, skipped: 0/);
  const st = await proj.cli(['migrate', '--yes']);
  assert.match(st.out, /No schema changes\./);
});

test('run executes the module with local code and shows logs', async () => {
  const r = await proj.cli(['run', 'message', '{ text: "hi" }']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /text is hi/);
  assert.match(r.out, /echo/);
});

test('run reports a failed module', async () => {
  proj.write('tgcloud/endpoints/crash.js', `export default async function () {\n  throw new Error('kaputt');\n}\n`);
  const r = await proj.cli(['run', 'endpoints/crash']);
  assert.equal(r.code, 1);
  assert.match(r.out, /kaputt/);
});

test('add scaffolds a new handler', async () => {
  const r = await proj.cli(['add', 'handlers/hello']);
  assert.equal(r.code, 0, r.out);
  assert.ok(proj.exists('tgcloud/handlers/hello.js'));
});

test('a targeted push deploys just that module', async () => {
  const r = await proj.cli(['push', 'handlers/hello']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Deploying 1 change…/);
  assert.ok(botOf().modules.has('handlers/hello'));
  assert.equal(proj.state().last_known_revision, 2);
});

test('a full push deletes remote-only modules, force skips the prompt', async () => {
  fs.unlinkSync(path.join(proj.dir, 'tgcloud/handlers/hello.js'));
  const r = await proj.cli(['push', '--force']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /handlers\/hello\.js \(deleted\)/);
  assert.ok(!botOf().modules.has('handlers/hello'));
});

test('pull restores local edits from the snapshot', async () => {
  const original = proj.read('tgcloud/handlers/message.js');
  proj.write('tgcloud/handlers/message.js', HANDLER + '// local edit\n');
  const r = await proj.cli(['pull'], { input: 'y\n' });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /saved/);
  assert.equal(proj.read('tgcloud/handlers/message.js'), original);
});

test('fetch refreshes the snapshot without touching files', async () => {
  proj.write('tgcloud/handlers/message.js', HANDLER + '// local edit\n');
  const r = await proj.cli(['fetch']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Snapshot updated/);
  assert.match(proj.read('tgcloud/handlers/message.js'), /local edit/);
});

test('reset restores a named file', async () => {
  const r = await proj.cli(['reset', 'handlers/message']);
  assert.equal(r.code, 0, r.out);
  assert.equal(proj.read('tgcloud/handlers/message.js'), HANDLER);
});

test('diff shows a patch for local edits', async () => {
  proj.write('tgcloud/handlers/message.js', HANDLER + '// tweak\n');
  const r = await proj.cli(['diff', 'handlers/message']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /tweak/);
  assert.match(r.out, /@@/);
  await proj.cli(['reset', 'handlers/message']);
});

test('wrong revision surfaces mismatch guidance, force fixes it', async () => {
  const state = proj.state();
  state.last_known_revision = 999;
  proj.write(proj.statePath(), JSON.stringify(state, null, 2));
  proj.write('tgcloud/handlers/message.js', HANDLER + '// tweak again\n');
  const bad = await proj.cli(['push']);
  assert.equal(bad.code, 1, bad.out);
  assert.match(bad.out, /moved on|mismatch/i);
  const good = await proj.cli(['push', '--force']);
  assert.equal(good.code, 0, good.out);
  const st = proj.state();
  assert.equal(st.last_known_revision, botOf().revision);
});

test('webhook prints state and syncs', async () => {
  const r = await proj.cli(['webhook']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /https:\/\/t\.te\//);
  const s = await proj.cli(['webhook', 'sync']);
  assert.equal(s.code, 0, s.out);
  assert.match(s.out, /Webhook synced\./);
});

test('logs shows recorded activity', async () => {
  const r = await proj.cli(['logs', '--n', '20']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /fetch|pull|reset|webhook|migrate|push/);
});

test('second identical push is a no-op', async () => {
  const r = await proj.cli(['push']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Nothing to deploy/);
});
