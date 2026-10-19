import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startMockCloud, stopMockCloud, Project } from './helpers/helpers.js';

let cloud;
let token;

test.before(async () => {
  cloud = await startMockCloud();
  token = cloud.mintToken();
});

test.after(async () => {
  if (cloud) await stopMockCloud(cloud);
});

test('login accepts a pasted token, links the folder, and logout forgets it', async () => {
  const proj = new Project(cloud, null, 'auth');
  await proj.cli(['init']);
  delete proj.env.TGPILOT_TOKEN;

  const login = await proj.cli(['login', token]);
  assert.equal(login.code, 0, login.out);
  assert.match(login.out, /Linked to app100/);  assert.match(login.out, /Synced the bot's current state/);
  assert.ok(proj.exists('.tgpilot/credentials'));

  // The folder is linked for real now: status works without any token env.
  const status = await proj.cli(['status']);
  assert.equal(status.code, 0, status.out);
  assert.match(status.out, /Linked to bot app100/);
  assert.match(status.out, /New, not deployed yet/);

  const out = await proj.cli(['logout']);
  assert.equal(out.code, 0, out.out);
  assert.match(out.out, /Token for app100 removed/);
  assert.equal(proj.exists('.tgpilot/credentials'), false);
  assert.match((await proj.cli(['logout'])).out, /Nothing to forget/);
});

test('login rejects a malformed token without saving anything', async () => {
  const proj = new Project(cloud, null, 'auth-bad');
  await proj.cli(['init']);
  delete proj.env.TGPILOT_TOKEN;

  const bad = await proj.cli(['login', 'not-a-token']);
  assert.equal(bad.code, 1, bad.out);
  assert.match(bad.out, /does not look like an access token/);
  assert.equal(proj.exists('.tgpilot/credentials'), false);
});
