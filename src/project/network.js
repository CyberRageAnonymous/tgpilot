import dns from 'node:dns/promises';
import net from 'node:net';
import { loadState, saveState } from './state.js';
import { proxyFromEnv } from '../api/tunnel.js';
import { probeAddress, isHijacked, familyFromEnv } from '../api/http.js';

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
  };
}

// The effective configuration: project setting first, environment second.
export function networkConfig() {
  const saved = stored();
  const envProxy = ENV_PROXY();
  const envApi = ENV_API_URL();
  const envFamily = familyFromEnv();
  return {
    proxy: saved.proxy !== null ? saved.proxy : envProxy,
    apiUrl: saved.apiUrl !== null ? saved.apiUrl : envApi,
    family: saved.family !== null ? saved.family : envFamily,
    proxySource: saved.proxy !== null ? 'project' : envProxy ? 'environment' : 'none',
    apiUrlSource: saved.apiUrl !== null ? 'project' : envApi ? 'environment' : 'default',
    familySource: saved.family !== null ? 'project' : envFamily ? 'environment' : 'auto',
  };
}

export function saveNetworkConfig({ proxy, apiUrl, family } = {}) {
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

// The same checks the CLI prints, as data, so the studio can show the same
// story in the browser.
export async function diagnose({ apiUrl, proxy, deep = true } = {}) {
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

  if (deep && addresses.length) {
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
        hint: 'use a proxy, or force the other family with TGPILOT_IP_FAMILY=6',
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
  }

  return { config: { ...networkConfig(), proxy: proxyValue, apiUrl: base }, steps };
}
