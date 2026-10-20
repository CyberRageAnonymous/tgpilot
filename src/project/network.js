import dns from 'node:dns/promises';
import net from 'node:net';
import { loadState, saveState } from './state.js';
import { proxyFromEnv } from '../api/tunnel.js';

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
  };
}

// The effective configuration: project setting first, environment second.
export function networkConfig() {
  const saved = stored();
  const envProxy = ENV_PROXY();
  const envApi = ENV_API_URL();
  return {
    proxy: saved.proxy !== null ? saved.proxy : envProxy,
    apiUrl: saved.apiUrl !== null ? saved.apiUrl : envApi,
    proxySource: saved.proxy !== null ? 'project' : envProxy ? 'environment' : 'none',
    apiUrlSource: saved.apiUrl !== null ? 'project' : envApi ? 'environment' : 'default',
  };
}

export function saveNetworkConfig({ proxy, apiUrl }) {
  const state = loadState();
  state.network = {
    proxy: typeof proxy === 'string' ? proxy.trim() : null,
    apiUrl: typeof apiUrl === 'string' ? apiUrl.trim() : null,
  };
  saveState(state);
  return networkConfig();
}

function isPrivate(ip) {
  // Loopback is a normal answer for a local server; the others point at a
  // router or a sinkhole, never at a public cloud.
  if (ip.startsWith('10.') || ip.startsWith('192.168.')) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  if (ip.startsWith('169.254.')) return true;
  return false;
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
export async function diagnose({ apiUrl, proxy } = {}) {
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
    const privateOnes = addresses.filter((ip) => isPrivate(ip));
    if (privateOnes.length) {
      steps.push({
        id: 'dns-filtered',
        ok: false,
        text: `DNS: ${privateOnes.join(', ')} is a private address — that usually means a filtered or hijacked DNS answer`,
        hint: 'a direct connection will not get through; use a proxy',
      });
    }
  } catch (err) {
    steps.push({
      id: 'dns',
      ok: false,
      text: `DNS: ${new URL(base).hostname} — ${err.code || err.message}`,
      hint: 'the domain does not resolve; a proxy that resolves it for you is the way out',
    });
  }

  return { config: { ...networkConfig(), proxy: proxyValue, apiUrl: base }, steps };
}
