import dns from 'node:dns/promises';
import net from 'node:net';
import { loadState, saveState } from './state.js';
import { proxyFromEnv } from '../api/tunnel.js';
import { probeAddress, isHijacked, familyFromEnv } from '../api/http.js';
import { dohResolve } from '../api/doh.js';

// Where the tool talks to, and how it gets there. The studio can change this
// at runtime (a saved project setting), the environment can override it for
// a single shell. A proxy set in the project wins over the environment,
// because that is the setting the user typed into the studio.

const ENV_PROXY = () =>
  process.env.TGPILOT_PROXY ||
  process.env.HTTPS_PROXY ||
  process.env.https_proxy ||
  process.env.ALL_PROXY ||
  process.env.all_proxy ||
  '';

const ENV_API_URL = () => process.env.TGPILOT_API_URL || process.env.TG_CLOUD_API_URL || '';

function stored() {
  const state = loadState();
  const net_ = state.network && typeof state.network === 'object' ? state.network : {};
  return {
    proxy: typeof net_.proxy === 'string' ? net_.proxy : null,
    apiUrl: typeof net_.apiUrl === 'string' ? net_.apiUrl : null,
    family: net_.family === 4 || net_.family === 6 ? net_.family : null,
    doh: net_.doh === true,
  };
}

// The effective configuration: project setting first, environment second.
export function networkConfig() {
  const saved = stored();
  const envProxy = ENV_PROXY();
  const envApi = ENV_API_URL();
  const envFamily = familyFromEnv();
  const envDoh = process.env.TGPILOT_DOH === '1' || process.env.TGPILOT_DOH === 'true';
  return {
    proxy: saved.proxy !== null ? saved.proxy : envProxy,
    apiUrl: saved.apiUrl !== null ? saved.apiUrl : envApi,
    family: saved.family !== null ? saved.family : envFamily,
    proxySource: saved.proxy !== null ? 'project' : envProxy ? 'environment' : 'none',
    apiUrlSource: saved.apiUrl !== null ? 'project' : envApi ? 'environment' : 'default',
    familySource: saved.family !== null ? 'project' : envFamily ? 'environment' : 'auto',
    doh: saved.doh || envDoh,
    dohSource: saved.doh ? 'project' : envDoh ? 'environment' : 'off',
  };
}

export function saveNetworkConfig({ proxy, apiUrl, family, doh } = {}) {
  const state = loadState();
  const previous = state.network && typeof state.network === 'object' ? state.network : {};
  state.network = {
    proxy: proxy === undefined ? (typeof previous.proxy === 'string' ? previous.proxy : null) : proxy.trim(),
    apiUrl: apiUrl === undefined ? (typeof previous.apiUrl === 'string' ? previous.apiUrl : null) : apiUrl.trim(),
    family:
      family === undefined
        ? previous.family === 4 || previous.family === 6
          ? previous.family
          : null
        : family === 4 || family === 6
          ? Number(family)
          : null,
    doh: doh === undefined ? previous.doh === true : doh === true || doh === 'true',
  };
  saveState(state);
  return networkConfig();
}

// Is anything listening on the proxy port? This is the most common failure,
// so it gets checked before anything else.
export async function proxyPortAlive(proxy) {
  let url;
  try {
    url = new URL(proxy);
  } catch {
    return null;
  }
  const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 1080);
  return new Promise((resolve) => {
    const socket = net.connect({ host: url.hostname, port });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(3000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

// Local proxy ports that the usual clients open. Finding one is the
// fastest way out of a filtered network — and the user usually does not
// remember the number.
const DEFAULT_PROXY_PORTS = [1080, 10808, 10809, 1081, 7890, 7891, 7897, 8080, 8118, 20170, 2080];

function candidatePorts() {
  const raw = String(process.env.TGPILOT_PROXY_PORTS || '').trim();
  if (!raw) return DEFAULT_PROXY_PORTS;
  const ports = raw
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((port) => Number.isInteger(port) && port > 0 && port < 65536);
  return ports.length ? ports : DEFAULT_PROXY_PORTS;
}

// A SOCKS5 server greets with 0x05 as soon as you connect; an HTTP proxy
// stays silent until it gets a request. That difference is enough to tell
// the two apart.
function classifyPort(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let first = null;
    const done = (kind) => {
      try {
        socket.destroy();
      } catch {
        /* already gone */
      }
      resolve(kind);
    };
    socket.setTimeout(600, () => done(first === 0x05 ? 'socks5' : 'http'));
    socket.once('data', (chunk) => {
      first = chunk[0];
      done(first === 0x05 ? 'socks5' : 'http');
    });
    socket.once('connect', () => socket.write(Buffer.from([0x05, 0x01, 0x00])));
    socket.once('error', () => done(null));
  });
}

export async function detectLocalProxies() {
  const found = [];
  for (const port of candidatePorts()) {
    const kind = await classifyPort(port);
    if (kind) found.push({ host: '127.0.0.1', port, kind });
  }
  return found;
}

// The same checks the CLI prints, as data, so the studio can show the same
// story in the browser.
//
// `probe` stays off by default on purpose: it opens direct connections to
// the cloud addresses (and to a DNS-over-HTTPS resolver) to find out which
// route works. On a machine whose network is watched by a VPN client such
// extra connections can disturb it, so they only happen when asked for.
export async function diagnose({ apiUrl, proxy, deep = true, probe = false } = {}) {
  const config = networkConfig();
  const base = apiUrl || config.apiUrl || 'https://cloud.telegram.org';
  const proxyValue = proxy === undefined ? config.proxy : proxy;
  const steps = [];

  if (proxyValue) {
    const alive = await proxyPortAlive(proxyValue);
    steps.push({
      id: 'proxy',
      ok: alive === true,
      text:
        alive === true
          ? `Proxy: the port answers (${proxyValue})`
          : alive === false
            ? `Proxy: nothing is listening on ${proxyValue}`
            : `Proxy: ${proxyValue} is not a valid proxy address`,
      hint:
        alive === true
          ? ''
          : 'start the proxy/VPN app, or correct the port — socks5://host:port and http://host:port both work',
    });
  } else if (deep) {
    // No proxy configured: a local one is often running already.
    const local = await detectLocalProxies();
    if (local.length) {
      const first = local[0];
      const others = local.slice(1).map((p) => `${p.kind}://127.0.0.1:${p.port}`);
      steps.push({
        id: 'local-proxy',
        ok: true,
        text: `Local proxy found: ${first.kind}://${first.host}:${first.port}${others.length ? ` (also ${others.join(', ')})` : ''}`,
        hint: `use it with TGPILOT_PROXY=${first.kind}://${first.host}:${first.port}`,
      });
    }
  }

  let addresses = [];
  try {
    const target = new URL(base);
    addresses = (await dns.lookup(target.hostname, { all: true })).map((a) => a.address);
    steps.push({ id: 'dns', ok: true, text: `DNS: ${target.hostname} resolves to ${addresses.join(', ')}` });
  } catch (err) {
    steps.push({
      id: 'dns',
      ok: false,
      text: `DNS: ${new URL(base).hostname} — ${err.code || err.message}`,
      hint: 'the domain does not resolve; a proxy that resolves it for you is the way out',
    });
  }

  if (deep && probe && addresses.length) {
    const target = new URL(base);
    const port = Number(target.port) || (target.protocol === 'https:' ? 443 : 80);
    const v4 = addresses.find((ip) => ip.includes('.') && !ip.includes(':'));
    const v6 = addresses.find((ip) => ip.includes(':'));
    const hijacked = v4 && isHijacked(v4);
    if (hijacked) {
      steps.push({
        id: 'ipv4',
        ok: false,
        text: `IPv4: ${v4} is a private address — a hijacked DNS answer, this route can never work`,
        hint: 'use a proxy, force the other family with TGPILOT_IP_FAMILY=6, or turn on DNS over HTTPS',
      });
    }
    if (v6) {
      const probe = await probeAddress({ host: v6, family: 6, port, timeout: 4000 });
      steps.push({
        id: 'ipv6',
        ok: probe.ok,
        text: probe.ok ? `IPv6: ${v6} answers — this route works` : `IPv6: ${v6} — ${probe.reason}`,
        hint: probe.ok ? 'force it with TGPILOT_IP_FAMILY=6' : '',
      });
    }
    if (!hijacked && v4) {
      const probe = await probeAddress({ host: v4, family: 4, port, timeout: 4000 });
      steps.push({
        id: 'ipv4',
        ok: probe.ok,
        text: probe.ok ? `IPv4: ${v4} answers — this route works` : `IPv4: ${v4} — ${probe.reason}`,
        hint: '',
      });
    }

    // What a DNS-over-HTTPS resolver says about the same name — often the
    // only honest answer on a filtered network. Only asked for when the
    // route probe is on.
    try {
      const { v4: dohV4, v6: dohV6, resolver } = await dohResolve(target.hostname);
      const list = [...dohV6, ...dohV4].join(', ');
      steps.push({
        id: 'doh',
        ok: Boolean(list),
        text: list ? `DNS over HTTPS (${resolver}): ${list}` : `DNS over HTTPS (${resolver}): no answer`,
        hint: list
          ? hijacked
            ? 'the system DNS is hijacked — turn on DNS over HTTPS in the Network card'
            : ''
          : 'the resolver did not answer',
      });
    } catch (err) {
      steps.push({
        id: 'doh',
        ok: false,
        text: `DNS over HTTPS: ${err.code || err.message}`,
        hint: '',
      });
    }
  }

  return { config: { ...networkConfig(), proxy: proxyValue, apiUrl: base }, steps };
}
