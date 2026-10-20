import net from 'node:net';
import tls from 'node:tls';
import { URL } from 'node:url';

// Speaks HTTP(S) through a proxy — no extra packages. Two kinds work and are
// even detected automatically:
//   * HTTP CONNECT proxies (v2rayN "http port", clash "mixed port")
//   * SOCKS5 proxies (v2rayN "socks port", clash "socks-port")
// Telegram domains are blocked on some networks; this is how users get
// through their local proxy/VPN application.

export function proxyFromEnv() {
  return (
    process.env.TGPILOT_PROXY ||
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy ||
    ''
  );
}

export function hasProxy() {
  return Boolean(proxyFromEnv());
}

function requestTimeout() {
  return Number(process.env.TGPILOT_TIMEOUT) || 20000;
}

function debugOn() {
  return process.env.TGPILOT_DEBUG === '1' || process.env.TGCLOUD_DEBUG === '1';
}

// Stage-by-stage trace, so a failure can be located without guessing.
function trace(stage, extra) {
  if (!debugOn()) return;
  console.error(`[debug] tunnel: ${stage}${extra ? ` — ${extra}` : ''}`);
}

export class ProxyError extends Error {
  constructor(message, hint) {
    super(message);
    this.name = 'ProxyError';
    this.hint = hint;
  }
}

// A buffered reader: the socket keeps one permanent listener so no bytes
// are lost between reads.
//
// Every wait here has to mean "wait until MORE bytes arrive" — waiting for
// "the buffer is not empty" would spin in microtasks and never let the
// event loop read the socket again.
class Reader {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.waiters = [];
    this.error = null;
    this.ended = false;
    this.onData = (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.wake();
    };
    this.onEnd = () => {
      this.ended = true;
      this.wake();
    };
    this.onError = (err) => {
      this.error = err;
      this.wake();
    };
    socket.on('data', this.onData);
    socket.on('end', this.onEnd);
    socket.on('error', this.onError);
  }

  // Hands the socket over to somebody else (the TLS layer). A socket with
  // listeners would feed the same bytes to both of them and break the
  // handshake.
  detach() {
    this.socket.removeListener('data', this.onData);
    this.socket.removeListener('end', this.onEnd);
    this.socket.removeListener('error', this.onError);
  }

  wake() {
    const waiters = this.waiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  // Waits for the next chunk of data (or the end of the stream).
  async waitForData() {
    while (this.buffer.length === 0) {
      if (this.error) throw this.error;
      if (this.ended) return;
      await new Promise((resolve) => this.waiters.push(resolve));
    }
  }

  // Waits until the buffer holds at least n bytes.
  async ensure(n) {
    while (this.buffer.length < n) {
      if (this.error) throw this.error;
      if (this.ended) throw new ProxyError('the connection closed before the answer was complete');
      await new Promise((resolve) => this.waiters.push(resolve));
    }
  }

  async read(n) {
    await this.ensure(n);
    const out = this.buffer.subarray(0, n);
    this.buffer = this.buffer.subarray(n);
    return out;
  }

  async line() {
    while (true) {
      const idx = this.buffer.indexOf('\r\n');
      if (idx !== -1) {
        const out = this.buffer.subarray(0, idx);
        this.buffer = this.buffer.subarray(idx + 2);
        return out;
      }
      if (this.error) throw this.error;
      if (this.ended) throw new ProxyError('the connection closed in the middle of the answer');
      await new Promise((resolve) => this.waiters.push(resolve));
    }
  }

  async head() {
    while (true) {
      const idx = this.buffer.indexOf('\r\n\r\n');
      if (idx !== -1) {
        const out = this.buffer.subarray(0, idx + 4);
        this.buffer = this.buffer.subarray(idx + 4);
        return out;
      }
      if (this.error) throw this.error;
      if (this.ended) throw new ProxyError('the connection closed before the answer was complete');
      await new Promise((resolve) => this.waiters.push(resolve));
    }
  }

  async rest() {
    while (!this.ended && !this.error) {
      await new Promise((resolve) => this.waiters.push(resolve));
    }
    if (this.error) throw this.error;
    const out = this.buffer;
    this.buffer = Buffer.alloc(0);
    return out;
  }
}

function ipv4ToBuffer(host) {
  return Buffer.from(host.split('.').map((part) => Number(part) & 0xff));
}

function ipv6ToBuffer(host) {
  const [head, tail = ''] = host.split('::');
  const headParts = head ? head.split(':').filter(Boolean) : [];
  const tailParts = tail ? tail.split(':').filter(Boolean) : [];
  const missing = 8 - headParts.length - tailParts.length;
  const parts = [...headParts, ...Array(Math.max(0, missing)).fill('0'), ...tailParts];
  const bytes = Buffer.alloc(16);
  parts.slice(0, 8).forEach((part, i) => bytes.writeUInt16BE(Number.parseInt(part, 16) || 0, i * 2));
  return bytes;
}

// --- SOCKS5 -----------------------------------------------------------------

async function socksHandshake(reader, proxy, target, greeting) {
  const methods = greeting.slice(2, 2 + greeting[1]);
  const hasCreds = Boolean(proxy.username || proxy.password);
  let method = 0x00;
  if (methods.includes(0x02) && hasCreds) method = 0x02;
  else if (!methods.includes(0x00)) {
    if (methods.includes(0x02)) method = 0x02;
    else throw new ProxyError('the SOCKS5 proxy wants an authentication method this client does not know');
  }

  reader.socket.write(Buffer.from([0x05, method]));
  const reply = await reader.read(2);
  if (reply[1] === 0xff) {
    throw new ProxyError(
      'the SOCKS5 proxy rejected every offered authentication method',
      'check the user name and password in TGPILOT_PROXY (user:pass@host:port)'
    );
  }
  if (reply[1] === 0x02) {
    const user = Buffer.from(decodeURIComponent(proxy.username || ''), 'utf8');
    const pass = Buffer.from(decodeURIComponent(proxy.password || ''), 'utf8');
    reader.socket.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]));
    const authReply = await reader.read(2);
    if (authReply[1] !== 0x00) {
      throw new ProxyError(
        'the SOCKS5 proxy rejected the user name or password',
        'check the credentials in TGPILOT_PROXY (user:pass@host:port)'
      );
    }
  }

  const host = target.hostname;
  let atyp;
  let addr;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    atyp = 0x01;
    addr = ipv4ToBuffer(host);
  } else if (host.includes(':')) {
    atyp = 0x04;
    addr = ipv6ToBuffer(host);
  } else {
    atyp = 0x03;
    const name = Buffer.from(host, 'utf8');
    addr = Buffer.concat([Buffer.from([name.length]), name]);
  }
  const targetPort = Number(target.port) || (target.protocol === 'https:' ? 443 : 80);
  reader.socket.write(
    Buffer.concat([
      Buffer.from([0x05, 0x01, 0x00, atyp]),
      addr,
      Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff]),
    ])
  );

  const answer = await reader.read(4);
  trace('socks5 reply', `code ${answer[1]}`);
  if (answer[1] !== 0x00) {
    const reasons = {
      1: 'the proxy refused the connection (general failure)',
      2: 'the proxy refused the connection (rule not allowed)',
      3: 'the proxy refused the connection (network unreachable)',
      4: 'the proxy refused the connection (host unreachable)',
      5: 'the proxy refused the connection (connection refused)',
      6: 'the proxy refused the connection (TTL expired)',
      7: 'the proxy refused the connection (command not supported)',
      8: 'the proxy refused the connection (address type not supported)',
    };
    throw new ProxyError(reasons[answer[1]] || `the proxy refused the connection (SOCKS5 code ${answer[1]})`);
  }
  if (answer[3] === 0x01) await reader.read(4);
  else if (answer[3] === 0x04) await reader.read(16);
  else if (answer[3] === 0x03) {
    const len = (await reader.read(1))[0];
    await reader.read(len);
  }
  await reader.read(2);
}

// --- HTTP CONNECT -----------------------------------------------------------

async function httpConnect(reader, proxy, target) {
  const targetPort = Number(target.port) || (target.protocol === 'https:' ? 443 : 80);
  const auth =
    proxy.username || proxy.password
      ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}\r\n`
      : '';
  reader.socket.write(
    `CONNECT ${target.hostname}:${targetPort} HTTP/1.1\r\nHost: ${target.hostname}:${targetPort}\r\n${auth}\r\n`
  );
  const head = (await reader.head()).toString('latin1');
  const statusLine = head.split('\r\n')[0];
  if (!/^HTTP\//i.test(statusLine)) {
    throw new ProxyError(
      `the proxy did not answer the CONNECT (${statusLine.slice(0, 40) || 'no answer'})`,
      'that port may speak SOCKS5 — try TGPILOT_PROXY=socks5://host:port'
    );
  }
  const status = Number.parseInt(statusLine.split(' ')[1], 10);
  if (status === 407) {
    throw new ProxyError(
      'the proxy asked for a user name and password',
      'put them in TGPILOT_PROXY, e.g. http://user:pass@host:port'
    );
  }
  if (status !== 200) {
    throw new ProxyError(`the proxy refused the tunnel (${statusLine || 'no answer'})`);
  }
}

async function connectProxy(proxy, scheme) {
  const proxyPort = Number(proxy.port) || (proxy.protocol === 'https:' ? 443 : scheme === 'socks5' ? 1080 : 80);
  const socket = net.connect({ host: proxy.hostname, port: proxyPort });
  socket.setNoDelay(true);
  // A socket error after the tunnel is up must never take the process down.
  socket.on('error', (err) => trace('socket error', err.code || err.message));
  trace('connecting to the proxy', `${proxy.hostname}:${proxyPort}`);
  await new Promise((resolve, reject) => {
    const onError = (err) =>
      reject(
        new ProxyError(
          `nothing answered on the proxy port ${proxy.hostname}:${proxyPort} (${err.code || err.message})`,
          'start the proxy/VPN app, or fix the port in TGPILOT_PROXY'
        )
      );
    socket.once('error', onError);
    socket.once('connect', () => {
      socket.removeListener('error', onError);
      resolve();
    });
  });
  return socket;
}

// Waits for the first byte, but not forever: an HTTP proxy says nothing
// until we send CONNECT, while a SOCKS5 proxy greets us immediately.
// The byte is only looked at, never consumed.
async function peek(reader, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  const ready = (async () => {
    while (!reader.buffer.length && !reader.ended && !reader.error) await reader.waitForData();
    return true;
  })();
  const ok = await Promise.race([ready, timeout]);
  clearTimeout(timer);
  if (!ok) return null;
  if (reader.error) throw reader.error;
  return reader.buffer.length ? reader.buffer[0] : null;
}

// Opens a tunnel to the target and returns the socket that carries it.
async function openTunnel(proxy, target, scheme) {
  const socket = await connectProxy(proxy, scheme);
  const reader = new Reader(socket);

  trace('proxy connected');
  const greeting = await peek(reader, 1200);
  trace('proxy greeting', greeting === null ? 'none (http proxy?)' : `0x${greeting.toString(16)}`);
  if (greeting === 0x05) {
    await reader.read(1); // version byte, already peeked
    const count = (await reader.read(1))[0];
    const methods = count ? await reader.read(count) : Buffer.alloc(0);
    trace('socks5 handshake');
    await socksHandshake(reader, proxy, target, Buffer.concat([Buffer.from([0x05, count]), methods]));
    return { socket, reader };
  }
  if (greeting !== null && greeting !== 0x48) {
    socket.destroy();
    throw new ProxyError(
      `the proxy answered with unexpected bytes (0x${greeting.toString(16)}) instead of opening a tunnel`,
      'check that the port belongs to an HTTP or SOCKS5 proxy'
    );
  }

  try {
    await httpConnect(reader, proxy, target);
  } catch (err) {
    socket.destroy();
    throw err;
  }
  return { socket, reader };
}

// One plain HTTP/1.1 request through the tunnel. Resolves with a
// fetch-compatible { status, statusText, text() }.
export async function tunnelRequest({ method, url, headers = {}, body = null, timeout = requestTimeout(), proxy: proxyOption = proxyFromEnv() }) {
  let proxyUrl;
  let scheme;
  try {
    proxyUrl = new URL(proxyOption || proxyFromEnv());
    scheme = proxyUrl.protocol.replace(':', '');
    if (scheme === 'socks') scheme = 'socks5';
    if (!['http', 'https', 'socks5'].includes(scheme)) throw new Error('scheme');
    if (!proxyUrl.hostname) throw new Error('host');
  } catch {
    throw new ProxyError(
      `TGPILOT_PROXY is not a usable proxy address (${proxyOption || proxyFromEnv() || 'empty'})`,
      'expected http://host:port or socks5://host:port'
    );
  }

  const target = new URL(url);
  if (!/^https?:$/.test(target.protocol)) {
    throw new ProxyError(`unsupported scheme ${target.protocol}`);
  }

  const work = (async () => {
    trace('request', `${method} ${target.href} via ${scheme}`);
    const { socket, reader } = await openTunnel(proxyUrl, target, scheme);
    let stream = socket;
    try {
      if (target.protocol === 'https:') {
        // The TLS layer takes over the socket; the reader must let go of it
        // first, otherwise both would compete for the same bytes. The socket
        // also has to stop flowing — a flowing socket drops everything that
        // arrives after the handshake, and the body of the answer would
        // never be read.
        // Keep an error listener on the raw socket: without one, a late
        // socket error would be an uncaught exception.
        socket.on('error', (err) => trace('socket error during tls', err.code || err.message));
        trace('tls handshake', target.hostname);
        stream = tls.connect({ socket, servername: target.hostname });
        await new Promise((resolve, reject) => {
          stream.once('secureConnect', resolve);
          stream.once('error', (err) =>
            reject(new ProxyError(`the TLS handshake with ${target.host} failed (${err.code || err.message})`))
          );
        });
        trace('tls ready');
        return await readResponse(new Reader(stream), { method, target, headers, body });
      }
      return await readResponse(reader, { method, target, headers, body });
    } finally {
      try {
        // A graceful end avoids a TCP reset that could cut off a reply
        // the server is still writing.
        stream.end();
        const cleaner = setTimeout(() => {
          try {
            stream.destroy();
          } catch {
            /* already gone */
          }
        }, 100);
        cleaner.unref?.();
      } catch {
        /* already gone */
      }
    }
  })();

  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new ProxyError(`the connection to ${target.host} timed out after ${Math.round(timeout / 1000)} s`)),
      timeout
    );
  });
  // Whoever loses the race must not turn into an unhandled rejection — that
  // would take the whole studio process down with it.
  work.catch(() => {});
  guard.catch(() => {});
  try {
    return await Promise.race([work, guard]);
  } finally {
    clearTimeout(timer);
  }
}

async function readResponse(reader, { method, target, headers, body }) {
  const path = (target.pathname === '' ? '/' : target.pathname) + (target.search || '');
  let head = `${method} ${path} HTTP/1.1\r\nHost: ${target.host}\r\nConnection: close\r\n`;
  for (const [k, v] of Object.entries(headers)) head += `${k}: ${v}\r\n`;
  if (body && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-length')) {
    head += `Content-Length: ${body.length}\r\n`;
  }
  head += '\r\n';
  reader.socket.write(Buffer.concat([Buffer.from(head, 'utf8'), body || Buffer.alloc(0)]));

  const headBuf = await reader.head();
  trace('response head', headBuf.toString('latin1').split('\r\n')[0]);
  const headText = headBuf.toString('latin1');
  const lines = headText.split('\r\n');
  const parts = lines[0].split(' ');
  const map = {};
  for (const line of lines.slice(1)) {
    const i = line.indexOf(':');
    if (i > 0) map[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  const status = Number.parseInt(parts[1], 10) || 0;
  const statusText = (parts.slice(2).join(' ') || '').trim();
  trace('response headers', JSON.stringify(map));

  let payload;
  if (/^chunked$/i.test(map['transfer-encoding'] || '')) {
    const chunks = [];
    while (true) {
      const size = Number.parseInt((await reader.line()).toString('latin1').split(';')[0], 16);
      trace('chunk size', String(size));
      if (!Number.isFinite(size) || size === 0) break;
      chunks.push(await reader.read(size));
      await reader.read(2); // trailing CRLF
    }
    payload = Buffer.concat(chunks.length ? chunks : [Buffer.alloc(0)]);
  } else if (map['content-length']) {
    payload = await reader.read(Number.parseInt(map['content-length'], 10));
  } else {
    payload = await reader.rest();
  }

  return { status, statusText, headers: map, text: async () => String(payload) };
}
