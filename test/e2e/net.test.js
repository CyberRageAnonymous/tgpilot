import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startMockCloud, stopMockCloud, Project, startStudio, freePort } from './helpers/helpers.js';
import { startConnectProxy, startSocks5Proxy } from './helpers/proxy.js';
import http from 'node:http';
import net from 'node:net';

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

test('DNS over HTTPS replaces a hijacked system resolver', async () => {
  const proj = project('doh');
  // A stand-in resolver: it answers with the mock cloud's real address.
  const resolver = http.createServer((req, res) => {
    const name = new URL(req.url, 'http://resolver').searchParams.get('name');
    res.writeHead(200, { 'Content-Type': 'application/dns-json' });
    res.end(
      JSON.stringify({
        Status: 0,
        Answer: [
          { name, type: 1, data: '127.0.0.1' },
          { name, type: 28, data: '::1' },
        ],
      })
    );
  });
  const resolverPort = await new Promise((r) => resolver.listen(0, '127.0.0.1', () => r(resolver.address().port)));
  try {
    proj.env.TGPILOT_DOH = '1';
    proj.env.TGPILOT_DOH_URL = `http://127.0.0.1:${resolverPort}/dns-query`;
    const res = await proj.cli(['ping', '--probe']);
    assert.equal(res.code, 0, res.out);
    assert.match(res.out, /✓ Reach: the cloud answered/);
    assert.match(res.out, /Route probe: on/);
    assert.match(res.out, /DNS over HTTPS \(127\.0\.0\.1(:\d+)?\): ::1, 127\.0\.0\.1/);
  } finally {
    resolver.close();
  }
});

test('the studio can turn DNS over HTTPS on and off', async () => {
  const port = await freePort();
  const proj = new Project(cloud, null, 'dohstudio');
  proj.write('tgcloud/handlers/message.js', 'export default async function (message, ctx) { return 1; }\n');
  const child = await startStudio(proj, port);
  try {
    const off = await api(port, '/api/network');
    assert.equal(off.json.config.doh, false);
    const on = await api(port, '/api/network', { method: 'POST', body: { doh: true } });
    assert.equal(on.json.config.doh, true);
    assert.equal(on.json.config.dohSource, 'project');
    const back = await api(port, '/api/network', { method: 'POST', body: { doh: false } });
    assert.equal(back.json.config.doh, false);
  } finally {
    child.kill('SIGTERM');
  }
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

    const quiet = await api(port, '/api/network/test', { method: 'POST', body: {} });
    assert.equal(quiet.status, 200, quiet.text);
    assert.ok(!quiet.json.steps.some((s) => s.id === 'ipv4' || s.id === 'ipv6'), 'no route probes without asking');

    const forced = await api(port, '/api/network/test', { method: 'POST', body: { probe: true } });
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

test('the studio survives a proxy that never answers', async () => {
  const port = await freePort();
  // A proxy that accepts the connection and then says nothing: the request
  // has to time out. The studio must stay alive and keep serving.
  // It accepts, says nothing, and drops the connection after the request has
  // already timed out — that late failure is what used to kill the studio.
  const mute = net.createServer((client) => {
    setTimeout(() => client.destroy(), 900);
  });
  const mutePort = await new Promise((r) => mute.listen(0, '127.0.0.1', () => r(mute.address().port)));
  const proj = new Project(cloud, token, 'hang');
  proj.write('tgcloud/handlers/message.js', 'export default async function (message, ctx) { return 1; }\n');
  proj.env.TGPILOT_PROXY = `socks5://127.0.0.1:${mutePort}`;
  proj.env.TGPILOT_TIMEOUT = '300';
  const child = await startStudio(proj, port);
  try {
    const first = await api(port, '/api/webhook');
    assert.equal(first.status, 500, first.text);
    assert.match(first.json.error, /timed out|reach the server/i);

    // The studio is still there — a killed process would fail this.
    const second = await api(port, '/api/status');
    assert.equal(second.status, 200, second.text);
    const third = await api(port, '/api/project');
    assert.equal(third.status, 200, third.text);
  } finally {
    child.kill('SIGTERM');
    mute.close();
  }
});

test('HTTPS travels through a SOCKS5 proxy', async () => {
  // A TLS server on the other side of the proxy — the case that broke when
  // the tunnel and the TLS layer fought over the same socket.
  const https = await import('node:https');
  const { TEST_KEY, TEST_CERT } = await import('./helpers/tls.js');
  const server = https.createServer({ key: TEST_KEY, cert: TEST_CERT }, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, result: { hello: 'through the tunnel' } }));
  });
  const tlsPort = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

  const { server: proxyServer, port: proxyPort } = await startSocks5Proxy();
  try {
    const { tunnelRequest } = await import('../../src/api/tunnel.js');
    const previous = process.env.TGPILOT_PROXY;
    process.env.TGPILOT_PROXY = `socks5://127.0.0.1:${proxyPort}`;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    try {
      const out = await tunnelRequest({
        method: 'GET',
        url: `https://127.0.0.1:${tlsPort}/capabilities`,
        headers: { 'Content-Type': 'application/json' },
      });
      assert.equal(out.status, 200);
      assert.match(String(await out.text()), /through the tunnel/);
    } finally {
      if (previous === undefined) delete process.env.TGPILOT_PROXY;
      else process.env.TGPILOT_PROXY = previous;
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    }
  } finally {
    proxyServer.close();
    server.close();
  }
});

test('a body that arrives in its own packet is still read', async () => {
  // The head and the body in separate TLS records: the second one arrives
  // after the handshake, when a flowing socket would swallow it.
  const https = await import('node:https');
  const { TEST_KEY, TEST_CERT } = await import('./helpers/tls.js');
  const server = https.createServer({ key: TEST_KEY, cert: TEST_CERT }, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '44' });
    res.write('{"ok":true,"result":{"split":"into two');
    setTimeout(() => res.end(' packets"}}'), 120);
  });
  const tlsPort = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

  const { server: proxyServer, port: proxyPort } = await startSocks5Proxy();
  try {
    const { tunnelRequest } = await import('../../src/api/tunnel.js');
    const previous = process.env.TGPILOT_PROXY;
    process.env.TGPILOT_PROXY = `socks5://127.0.0.1:${proxyPort}`;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    try {
      const out = await tunnelRequest({
        method: 'GET',
        url: `https://127.0.0.1:${tlsPort}/capabilities`,
        headers: { 'Content-Type': 'application/json' },
      });
      assert.equal(out.status, 200);
      assert.match(String(await out.text()), /split/);
    } finally {
      if (previous === undefined) delete process.env.TGPILOT_PROXY;
      else process.env.TGPILOT_PROXY = previous;
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    }
  } finally {
    proxyServer.close();
    server.close();
  }
});

test('a running local proxy is discovered and named', async () => {
  const { server, port } = await startSocks5Proxy();
  try {
    const proj = project('discover');
    // the scanner only looks at the usual ports; point it at the test one
    proj.env.TGPILOT_PROXY_PORTS = String(port);
    const res = await proj.cli(['ping']);
    assert.equal(res.code, 0, res.out);
    assert.match(res.out, /Local proxy found: socks5:\/\/127\.0\.0\.1:\d+/);
    assert.match(res.out, /TGPILOT_PROXY=socks5:\/\/127\.0\.0\.1:\d+/);
  } finally {
    server.close();
  }
});

test('without proxy envs, behavior is identical to the direct path', async () => {
  const proj = project('direct');
  const res = await proj.cli(['ping']);
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /Proxy: \(not set/);
  assert.match(res.out, /✓ Reach/);
});
