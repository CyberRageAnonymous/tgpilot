import net from 'node:net';
import tls from 'node:tls';
import { URL } from 'node:url';

// Speaks HTTP(S) through an HTTP proxy with a CONNECT tunnel — no extra
// packages. Telegram domains are blocked on some networks; this is how users
// get through their local proxy/VPN application.

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

function parseHeaders(raw) {
  const lines = raw.split('\r\n');
  const parts = lines[0].split(' ');
  const map = {};
  for (const line of lines.slice(1)) {
    const i = line.indexOf(':');
    if (i > 0) map[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return { status: Number.parseInt(parts[1], 10) || 0, statusText: (parts.slice(2).join(' ') || '').trim(), headers: map };
}

function bodyLength(headers) {
  if (/^chunked$/i.test(headers['transfer-encoding'] || '')) return -1; // framing tells us when we are done
  if (headers['content-length']) return Number.parseInt(headers['content-length'], 10);
  return null; // read until the connection closes
}

// Strips HTTP/1.1 chunked framing ("size\r\n<data>\r\n"...).
function decodeChunked(input) {
  const parts = [];
  let i = 0;
  while (i < input.length) {
    const lineEnd = input.indexOf('\r\n', i);
    if (lineEnd === -1) break;
    const size = Number.parseInt(input.subarray(i, lineEnd).toString('latin1').split(';')[0], 16);
    if (!Number.isFinite(size) || size === 0) break;
    const start = lineEnd + 2;
    parts.push(input.subarray(start, start + size));
    i = start + size + 2;
  }
  return Buffer.concat(parts.length ? parts : [Buffer.alloc(0)]);
}

// One plain HTTP/1.1 request through the tunnel. Resolves with a
// fetch-compatible { status, statusText, text() }.
export function tunnelRequest({ method, url, headers = {}, body = null, timeout = requestTimeout() }) {
  let proxy;
  try {
    proxy = new URL(proxyFromEnv());
    if (!/^https?:$/.test(proxy.protocol) || !proxy.hostname || !proxy.port) throw new Error('shape');
  } catch {
    return Promise.reject(new Error(`TGPILOT_PROXY is not a usable proxy address (${proxyFromEnv() || 'empty'}) — expected http://host:port`));
  }
  const target = new URL(url);
  if (!/^https?:$/.test(target.protocol)) {
    return Promise.reject(new Error(`unsupported scheme ${target.protocol}`));
  }

  return new Promise((resolve, reject) => {
    const proxyPort = Number(proxy.port) || (proxy.protocol === 'https:' ? 443 : 80);
    const targetPort = Number(target.port) || (target.protocol === 'https:' ? 443 : 80);
    const auth =
      proxy.username || proxy.password
        ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}\r\n`
        : '';

    let buffered = Buffer.alloc(0);
    let response = null;
    let stream = null;
    let settled = false;

    function bail(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        stream?.destroy();
      } catch {
        /* already dead */
      }
      reject(err);
    }

    function finish() {
      if (settled || !response) return;
      settled = true;
      clearTimeout(timer);
      try {
        stream?.destroy();
      } catch {
        /* already done */
      }
      let payload = buffered;
      if (/^chunked$/i.test(response.headers['transfer-encoding'] || '')) payload = decodeChunked(buffered);
      resolve({
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        text: async () => String(payload),
      });
    }

    const timer = setTimeout(
      () => bail(new Error(`connection to ${target.host} timed out after ${Math.round(timeout / 1000)} s`)),
      timeout
    );
    timer.unref?.();

    function collect(chunk) {
      buffered = Buffer.concat([buffered, chunk]);
      if (!response) {
        const raw = buffered.toString('latin1');
        const end = raw.indexOf('\r\n\r\n');
        if (end === -1) return;
        response = parseHeaders(raw.slice(0, end));
        buffered = buffered.subarray(Buffer.byteLength(raw.slice(0, end + 4)));
      }
      const want = bodyLength(response.headers);
      if (want === 0 || (want !== null && want > 0 && buffered.length >= want)) finish();
    }

    function onStreamEnd() {
      // With "Connection: close" or missing framing the whole body has
      // arrived by now; anything else is a truncated answer.
      if (response) finish();
      else bail(new Error(`connection closed before a response arrived from ${target.host}`));
    }

    function sendRequest() {
      const path = (target.pathname === '' ? '/' : target.pathname) + (target.search || '');
      let head = `${method} ${path} HTTP/1.1\r\nHost: ${target.host}\r\nConnection: close\r\n`;
      for (const [k, v] of Object.entries(headers)) head += `${k}: ${v}\r\n`;
      if (body && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-length')) {
        head += `Content-Length: ${body.length}\r\n`;
      }
      head += '\r\n';
      stream.write(Buffer.concat([Buffer.from(head, 'utf8'), body || Buffer.alloc(0)]));
    }

    function goSecure(connectionRest) {
      if (connectionRest.length > 0) {
        // TLS needs our ClientHello first; stray bytes mean a broken proxy.
        bail(new Error('the proxy sent unexpected bytes through the tunnel'));
        return;
      }
      socket.removeAllListeners('data');
      socket.removeAllListeners('end');
      socket.removeAllListeners('error');
      stream = tls.connect({ socket, servername: target.hostname }, () => sendRequest());
      stream.on('data', collect);
      stream.on('end', onStreamEnd);
      stream.on('error', bail);
    }

    function goPlain(connectionRest) {
      socket.removeAllListeners('data');
      socket.removeAllListeners('error');
      socket.removeAllListeners('end');
      socket.removeAllListeners('close');
      stream = socket;
      socket.on('data', collect);
      socket.once('end', onStreamEnd);
      socket.once('close', onStreamEnd);
      sendRequest();
      if (connectionRest.length) collect(connectionRest);
    }

    const socket = net.connect({ host: proxy.hostname, port: proxyPort }, () => {
      socket.write(
        `CONNECT ${target.hostname}:${targetPort} HTTP/1.1\r\nHost: ${target.hostname}:${targetPort}\r\n${auth}\r\n`
      );
    });
    socket.setNoDelay(true);

    socket.on('data', (chunk) => {
      const raw = chunk.toString('latin1');
      const headerEnd = raw.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        if (raw.length > 16384) bail(new Error('the proxy did not answer the CONNECT'));
        return;
      }
      const status = Number.parseInt(raw.slice(0, raw.indexOf('\r\n')).split(' ')[1], 10);
      if (status !== 200) {
        bail(new Error(`the proxy refused the tunnel: ${status ?? '?'}`));
        return;
      }
      const rest = chunk.subarray(Buffer.byteLength(raw.slice(0, headerEnd + 4)));
      if (target.protocol === 'https:') {
        goSecure(rest);
      } else {
        goPlain(rest);
      }
    });
    socket.on('error', (err) => bail(err));
    socket.on('end', () => {
      if (!response) bail(new Error(`the proxy closed the connection (target ${target.host})`));
    });
    socket.on('close', () => bail(new Error(`the proxy closed the connection abruptly (target ${target.host})`)));
  });
}
