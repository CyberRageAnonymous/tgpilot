import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startMockCloud, stopMockCloud, Project } from './helpers/helpers.js';
import { startConnectProxy, startSocks5Proxy } from './helpers/proxy.js';

let cloud;

test.after(async () => {
  if (cloud) await stopMockCloud(cloud);
});

test.before(async () => {
  cloud = await startMockCloud();
});

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
  assert.match(res.out, /Start your proxy\/VPN app/);
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

test('without proxy envs, behavior is identical to the direct path', async () => {
  const proj = project('direct');
  const res = await proj.cli(['ping']);
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /Proxy: \(not set/);
  assert.match(res.out, /✓ Reach/);
});
