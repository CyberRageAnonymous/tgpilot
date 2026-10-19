import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startMockCloud, stopMockCloud, Project } from './helpers/helpers.js';
import net from 'node:net';

let cloud;

test.after(async () => {
  if (cloud) await stopMockCloud(cloud);
});

test.before(async () => {
  cloud = await startMockCloud();
});

// A minimal HTTP CONNECT relay, the same shape v2rayN/clash apps expose as
// their local "http port". Nothing listens before the CONNECT; afterwards the
// relay becomes a dumb pipe to the target host.
function startConnectProxy() {
  const server = net.createServer((client) => {
    client.once('data', (chunk) => {
      const line = chunk.toString('latin1').split('\r\n')[0];
      const m = /CONNECT ([^:]+):(\d+)/.exec(line);
      if (!m) {
        client.end('HTTP/1.1 403 Denied\r\n\r\n');
        return;
      }
      const upstream = net.connect(Number(m[2]), m[1], () => client.write('HTTP/1.1 200 OK\r\n\r\n'));
      client.on('error', () => upstream.destroy());
      upstream.on('error', () => client.destroy());
      client.pipe(upstream);
      upstream.pipe(client);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

test('cloud traffic can ride through an HTTP CONNECT proxy', async () => {
  const { server, port } = await startConnectProxy();
  try {
    const proj = new Project(cloud, null, 'proxied');
    proj.write('tgcloud/handlers/message.js', 'export default async function (message, ctx) { return 1; }\n');
    proj.env.TGPILOT_PROXY = `http://127.0.0.1:${port}`;
    // `ping` is the pure reachability probe, no token required.
    const res = await proj.cli(['ping']);
    assert.equal(res.code, 0, res.out);
    assert.match(res.out, /✓ DNS/);
    assert.match(res.out, /✓ Reach: the cloud answered/);
  } finally {
    server.close();
  }
});

test('a dead proxy produces the proxy hint, in one clear sentence', async () => {
  const proj = new Project(cloud, null, 'deadproxy');
  proj.write('tgcloud/handlers/message.js', 'export default async function (message, ctx) { return 1; }\n');
  proj.env.TGPILOT_PROXY = 'http://127.0.0.1:9';
  const res = await proj.cli(['ping']);
  assert.equal(res.code, 1, res.out);
  assert.match(res.out, /✓ DNS/);
  assert.match(res.out, /✗ Reach: .*The configured proxy http:\/\/127\.0\.0\.1:9 also failed/);
  assert.doesNotMatch(res.out, /ECONNREFUSED|fetch failed/);
  assert.match(res.out, /the configured proxy http:\/\/127\.0\.0\.1:9 also failed/i);
});

test('a failing DNS gets the DoH line before any proxy is touched', async () => {
  const proj = new Project(cloud, null, 'nxdomain');
  proj.write('tgcloud/handlers/message.js', 'export default async function (message, ctx) { return 1; }\n');
  proj.env.TGPILOT_API_URL = 'http://no-such-host-intentionally.invalid:9';
  proj.env.TGPILOT_PROXY = '';
  const res = await proj.cli(['ping']);
  assert.equal(res.code, 1, res.out);
  assert.match(res.out, /✗ DNS: no-such-host-intentionally\.invalid — (ENOTFOUND|EAI_AGAIN)/);
  assert.match(res.out, /TGPILOT_PROXY=http:\/\/host:port/);
});

test('without proxy envs, behavior is identical to the direct path', async () => {
  const proj = new Project(cloud, null, 'direct');
  proj.write('tgcloud/handlers/message.js', 'export default async function (message, ctx) { return 1; }\n');
  const res = await proj.cli(['ping']);
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /Proxy: \(not set/);
  assert.match(res.out, /✓ Reach/);
});
