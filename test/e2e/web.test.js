import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startMockCloud, stopMockCloud, Project, startStudio, freePort } from './helpers/helpers.js';

let cloud;
let token;
let proj;

test.after(async () => {
  if (cloud) await stopMockCloud(cloud);
});

test.before(async () => {
  cloud = await startMockCloud();
  token = cloud.mintToken();
  proj = new Project(cloud, token, 'studio');
  proj.write('tgcloud/handlers/message.js', 'export default async function (message, ctx) { console.log(2); return { echo: 1 }; }\n');
});

const api = async (childPort, path, { method = 'GET', body } = {}) => {
  const res = await fetch(`http://127.0.0.1:${childPort}${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ui payload */ }
  return { status: res.status, text, json };
};

test('the studio serves the UI and a safe local API', async () => {
  const port = await freePort();
  const child = await startStudio(proj, port);
  try {
    const ui = await api(port, '/');
    assert.equal(ui.status, 200);
    assert.match(ui.text, /tgpilot studio/);

    const status = await api(port, '/api/status');
    assert.equal(status.status, 200, status.text);
    assert.equal(typeof status.json.token.secret, 'undefined');
    assert.equal(status.json.token.masked, 'app100');

    const file = await api(port, '/api/file?path=tgcloud%2Fhandlers%2Fmessage.js');
    assert.equal(file.status, 200);
    assert.match(file.text, /message/);

    const tree = await api(port, '/api/tree');
    assert.equal(tree.status, 200, tree.text);
    assert.match(JSON.stringify(tree.json), /tgcloud/);

    const forbidden = await api(port, '/api/file?path=.tgpilot%2Fstate.json');
    assert.equal(forbidden.status, 400);

    const escape = await api(port, '/api/file?path=..%2Fpackage.json');
    assert.equal(escape.status, 400);

    const created = await api(port, '/api/file', { method: 'POST', body: { path: 'tgcloud/lib/scratch.js', content: '// scratch\n' } });
    assert.equal(created.status, 200, created.text);
    assert.ok(proj.read('tgcloud/lib/scratch.js'));

    const badWrite = await api(port, '/api/file', { method: 'POST', body: { path: 'tgcloud/../evil.js', content: 'x' } });
    assert.equal(badWrite.status, 400);

    const run = await api(port, '/api/run', { method: 'POST', body: { module: 'message', args: { text: 'web-run' } } });
    assert.equal(run.status, 200, run.text);
    assert.match(JSON.stringify(run.json.result), /echo/);
    assert.ok(Array.isArray(run.json.log));

    const pushed = await api(port, '/api/push', { method: 'POST', body: {} });
    assert.equal(pushed.status, 200, pushed.text);

    const webhook = await api(port, '/api/webhook');
    assert.equal(webhook.status, 200);
    assert.match(webhook.json.webhook.url, /https:\/\/t\.te\//);

    const logs = await api(port, '/api/logs');
    assert.equal(logs.status, 200);
  } finally {
    child.kill('SIGTERM');
  }
});

test('linking a bot from the studio works and bad tokens are rejected', async () => {
  const port = await freePort();
  const child = await startStudio(proj, port);
  try {
    const bad = await api(port, '/api/bot', { method: 'POST', body: { token: 'definitely:wrong' } });
    assert.equal(bad.status, 400, bad.text);

    const good = await api(port, '/api/bot', { method: 'POST', body: { token } });
    assert.equal(good.status, 200, good.text);
    assert.equal(good.json.token.masked, 'app100');
  } finally {
    child.kill('SIGTERM');
  }
});
