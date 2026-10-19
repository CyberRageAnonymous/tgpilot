import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startMockCloud, stopMockCloud, Project } from './helpers/helpers.js';

let cloud;
let token;
let proj;
let botOf;

test.after(async () => {
  if (cloud) await stopMockCloud(cloud);
});

test.before(async () => {
  cloud = await startMockCloud();
  token = cloud.mintToken();
  proj = new Project(cloud, token, 'static');
  botOf = () => cloud.bots.get([...cloud.bots.keys()][0]);
});

test('undeclared bot blocks a plain push until fetch, then a targeted push works', async () => {
  // The bot already serves content this folder has never seen.
  botOf().modules.set('handlers/other', 'export default async function () {}\n');
  botOf().revision = 5;

  proj.write('tgcloud/handlers/message.js', 'export default async function (message, ctx) { return { echo: message.text }; }\n');
  const blocked = await proj.cli(['push']);
  assert.equal(blocked.code, 1, blocked.out);
  assert.match(blocked.out, /never synced|already has|fetch/i);

  const fetched = await proj.cli(['fetch']);
  assert.equal(fetched.code, 0, fetched.out);

  // handlers/other is visible as remote-only; confirming the deletion
  // pushes mirror the folder onto the bot.
  const r = await proj.cli(['push'], { input: 'y\n' });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Done in /);
  assert.ok(!botOf().modules.has('handlers/other'));
  assert.equal(proj.state().last_known_revision, 6);
});

test('static publish uploads the build and serves a URL', async () => {
  proj.write('dist/index.html', '<html>hello app</html>\n');
  proj.write('dist/assets/app.f3ab.css', 'body{color:#222}\n');
  proj.write('tgcloud.jsonc', '{\n  "static": {\n    "source": "dist",\n    "spa": true\n  }\n}\n');

  const r = await proj.cli(['push'], { input: 'y\n' });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /uploaded \(|already stored/);
  assert.match(r.out, /Mini App online at https:\/\/cdn\.mock\//);
  assert.equal(botOf().staticState.config.spa, true);
  assert.ok(botOf().staticState.manifest['index.html']);
});

test('a later status is clean and shows the hosted app', async () => {
  const r = await proj.cli(['status']);
  assert.match(r.out, /Everything matches the last deployed state\./);
  assert.match(r.out, /cdn\.mock\//);
});

test('static content change only re-uploads the touched file', async () => {
  proj.write('dist/assets/new.bin', 'v2\n');
  proj.write('tgcloud.jsonc', '{\n  "static": {\n    "source": "dist",\n    "spa": false\n  }\n}\n');

  const blobsBefore = botOf().staticState.blobs.size;
  const r = await proj.cli(['push'], { input: 'y\n' });
  assert.equal(r.code, 0, r.out);
  const blobsAfter = botOf().staticState.blobs.size;
  assert.equal(blobsAfter, blobsBefore + 1);
  assert.equal(botOf().staticState.config.spa, false);

  const again = await proj.cli(['push'], { input: 'y\n' });
  assert.match(again.out, /Nothing to deploy/);
});

test('"static": false removes the Mini App', async () => {
  proj.write('tgcloud.jsonc', '{\n  "static": false\n}\n');
  const r = await proj.cli(['push'], { input: 'y\n' });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Mini App files removed/);
  assert.equal(botOf().staticState, null);

  const again = await proj.cli(['push'], { input: 'y\n' });
  assert.match(again.out, /Nothing to deploy/);
});
