import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';

// The direct path to the cloud, with control over the IP family. On filtered
// networks the IPv4 answer is often a hijacked private address while the
// IPv6 answer is genuine — being able to pick a family is the difference
// between "no internet" and "working".

// A private answer where a public one is expected means the DNS was
// hijacked — that address can never work.
export function isHijacked(ip) {
  if (ip.startsWith('10.') || ip.startsWith('192.168.')) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  if (ip.startsWith('169.254.')) return true;
  if (ip.startsWith('100.64.') || ip.startsWith('0.')) return true;
  return false;
}

const familyCache = new Map();

// Some networks answer with a hijacked IPv4 address but a genuine IPv6 one.
// Picking the family that can work is the difference between "no internet"
// and "working", so the direct path prefers it.
export async function preferredFamily(hostname) {
  const cached = familyCache.get(hostname);
  if (cached && Date.now() - cached.at < 60000) return cached.family;

  let family = 0;
  try {
    const [v4, v6] = await Promise.all([
      dns.lookup(hostname, { family: 4 }).catch(() => null),
      dns.lookup(hostname, { family: 6 }).catch(() => null),
    ]);
    if (v6 && (!v4 || isHijacked(v4.address))) family = 6;
  } catch {
    family = 0;
  }
  familyCache.set(hostname, { at: Date.now(), family });
  return family;
}

export function familyFromEnv() {
  const raw = String(process.env.TGPILOT_IP_FAMILY || '').trim();
  if (raw === '4') return 4;
  if (raw === '6') return 6;
  return 0; // any
}

function lookupFor(family) {
  if (!family) return undefined;
  return (hostname, options, callback) => {
    dns.lookup(hostname, { ...options, family }, callback);
  };
}

// A plain HTTP(S) request with a fetch-compatible answer, so the envelope
// parser does not care how the bytes arrived.
export function directRequest({ method, url, headers = {}, body = null, family = familyFromEnv(), timeout = 20000 }) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      reject(new Error(`not a valid address: ${url}`));
      return;
    }
    const lib = target.protocol === 'https:' ? https : http;
    const request = lib.request(
      {
        method,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: (target.pathname === '' ? '/' : target.pathname) + (target.search || ''),
        headers,
        timeout,
        ...(lookupFor(family) ? { lookup: lookupFor(family) } : {}),
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode || 0,
            statusText: res.statusMessage || '',
            headers: res.headers,
            text: async () => Buffer.concat(chunks).toString('utf8'),
          })
        );
        res.on('error', reject);
      }
    );
    request.on('error', reject);
    request.on('timeout', () => {
      request.destroy(new Error(`the request timed out after ${Math.round(timeout / 1000)} s`));
    });
    if (body) request.write(body);
    request.end();
  });
}

// A bare connection probe for one family: "can this machine even open a
// connection to that address?".
export function probeAddress({ host, family = 0, port = 443, timeout = 5000, secure = true }) {
  return new Promise((resolve) => {
    const socket = secure
      ? tls.connect({ host, port, family: family || undefined, servername: host, rejectUnauthorized: false })
      : net.connect({ host, port, family: family || undefined });
    const done = (result) => {
      try {
        socket.destroy();
      } catch {
        /* already gone */
      }
      resolve(result);
    };
    socket.setTimeout(timeout, () => done({ ok: false, reason: 'timeout' }));
    socket.once('connect', () => done({ ok: true }));
    socket.once('error', (err) => done({ ok: false, reason: err.code || err.message }));
  });
}
