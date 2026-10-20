import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startMockCloud, stopMockCloud, Project, startStudio, freePort } from './helpers/helpers.js';
import { startConnectProxy, startSocks5Proxy } from './helpers/proxy.js';

let cloud;

test.after(async () => {
  if (cloud) await stopMockCloud(cloud);
});

test.before(async () => {
  cloud = await startMockCloud();
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

const project = (name) => {
  const proj = new Project(cloud, null, name);
  proj.write('tgcloud/handlers/message.js', 'export default async function (message, ctx) { return 1; }\n');
  return proj;
};

test('cloud traffic can ride through an HTTP CONNECT proxy', async () => {
  const { server, port } = await startConnectProxy();
  try {
    const proj = project('proxied');
    proj.env.TGPILOT_PROXY = `http://127.0.0.1:${port}`;
    const res = await proj.cli(['ping']);
    assert.equal(res.code, 0, res.out);
    assert.match(res.out, /✓ DNS/);
    assert.match(res.out, /✓ Reach: the cloud answered/);
  } finally {
    server.close();
  }
});

test('cloud traffic can ride through a SOCKS5 proxy', async () => {
  const { server, port } = await startSocks5Proxy();
  try {
    const proj = project('socks');
    proj.env.TGPILOT_PROXY = `socks5://127.0.0.1:${port}`;
    const res = await proj.cli(['ping']);
    assert.equal(res.code, 0, res.out);
    assert.match(res.out, /✓ Reach: the cloud answered/);
  } finally {
    server.close();
  }
});

test('a SOCKS5 proxy is detected even when the address says http://', async () => {
  const { server, port } = await startSocks5Proxy();
  try {
    const proj = project('mixed');
    proj.env.TGPILOT_PROXY = `http://127.0.0.1:${port}`;
    const res = await proj.cli(['ping']);
    assert.equal(res.code, 0, res.out);
    assert.match(res.out, /✓ Reach: the cloud answered/);
  } finally {
    server.close();
  }
});

test('a SOCKS5 proxy with user and password works', async () => {
  const { server, port } = await startSocks5Proxy({ user: 'pilot', password: 'secret' });
  try {
    const proj = project('socksauth');
    proj.env.TGPILOT_PROXY = `socks5://pilot:secret@127.0.0.1:${port}`;
    const res = await proj.cli(['ping']);
    assert.equal(res.code, 0, res.out);
    assert.match(res.out, /✓ Reach: the cloud answered/);
  } finally {
    server.close();
  }
});

test('a dead proxy is spotted before anything else is tried', async () => {
  const proj = project('deadproxy');
  proj.env.TGPILOT_PROXY = 'http://127.0.0.1:9';
  const res = await proj.cli(['ping']);
  assert.equal(res.code, 1, res.out);
  assert.match(res.out, /✗ Proxy: nothing is listening on http:\/\/127\.0\.0\.1:9/);
  assert.match(res.out, /Hint: start the proxy\/VPN app, or correct the port/);
});

test('a failing DNS gets the DoH line before any proxy is touched', async () => {
  const proj = project('nxdomain');
  proj.env.TGPILOT_API_URL = 'http://no-such-host-intentionally.invalid:9';
  proj.env.TGPILOT_PROXY = '';
  const res = await proj.cli(['ping']);
  assert.equal(res.code, 1, res.out);
  assert.match(res.out, /✗ DNS: no-such-host-intentionally\.invalid — (ENOTFOUND|EAI_AGAIN)/);
  assert.match(res.out, /TGPILOT_PROXY=http:\/\/host:port/);
});

test('the studio can force an IP family', async () => {
  const port = await freePort();
  const proj = new Project(cloud, null, 'family');
  proj.write('tgcloud/handlers/message.js', 'export default async function (message, ctx) { return 1; }\n');
  const child = await startStudio(proj, port);
  try {
    const saved = await api(port, '/api/network', { method: 'POST', body: { family: '6' } });
    assert.equal(saved.status, 200, saved.text);
    assert.equal(saved.json.config.family, 6);
    assert.equal(saved.json.config.familySource, 'project');

    const forced = await api(port, '/api/network/test', { method: 'POST', body: {} });
    assert.equal(forced.status, 200, forced.text);
    assert.ok(forced.json.steps.some((s) => s.id === 'ipv4' || s.id === 'ipv6'));

    const back = await api(port, '/api/network', { method: 'POST', body: { family: 'auto' } });
    assert.equal(back.json.config.family, 0);

    const wrong = await api(port, '/api/network', { method: 'POST', body: { family: '9' } });
    assert.equal(wrong.status, 400);
  } finally {
    child.kill('SIGTERM');
  }
});

test('a direct request works with the new http path', async () => {
  const proj = project('direct-http');
  const res = await proj.cli(['ping']);
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /✓ Reach: the cloud answered/);
  assert.match(res.out, /IP family: auto/);
});

test('without proxy envs, behavior is identical to the direct path', async () => {
  const proj = project('direct');
  const res = await proj.cli(['ping']);
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /Proxy: \(not set/);
  assert.match(res.out, /✓ Reach/);
});
