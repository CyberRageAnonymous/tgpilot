import { directRequest } from './http.js';

// DNS over HTTPS. A filtered network answers with a hijacked address; a DoH
// resolver talks to a DNS server over HTTPS, where the filter has no say.
// The result is the genuine address of the cloud, and tgpilot connects to it
// directly.

const DEFAULT_ENDPOINTS = [
  { host: '1.1.1.1', servername: 'cloudflare-dns.com', path: '/dns-query' },
  { host: '8.8.8.8', servername: 'dns.google', path: '/resolve' },
];

function endpointFromEnv() {
  const raw = String(process.env.TGPILOT_DOH_URL || '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return { url };
  } catch {
    return null;
  }
}

// Pulls the addresses out of a JSON DNS answer ({ Answer: [{ type, data }] }).
export function dohParse(payload) {
  const answers = Array.isArray(payload?.Answer) ? payload.Answer : [];
  const v4 = [];
  const v6 = [];
  for (const answer of answers) {
    if (answer?.type === 1 && typeof answer.data === 'string') v4.push(answer.data);
    if (answer?.type === 28 && typeof answer.data === 'string') v6.push(answer.data.replace(/^\[|\]$/g, ''));
  }
  return { v4, v6 };
}

// Asks a DoH resolver for the real addresses of a name.
export async function dohResolve(name, { timeout = 4000 } = {}) {
  const custom = endpointFromEnv();
  const attempts = custom
    ? [{ url: custom.url }]
    : DEFAULT_ENDPOINTS.map((endpoint) => ({
        url: `https://${endpoint.servername}${endpoint.path}`,
        connectIp: endpoint.host,
        servername: endpoint.servername,
      }));

  const errors = [];
  for (const attempt of attempts) {
    try {
      const target = new URL(attempt.url);
      const query = `name=${encodeURIComponent(name)}&type=${target.pathname.includes('resolve') ? 'A' : 'A'}`;
      const separator = target.search ? '&' : '?';
      const url = `${target.origin}${target.pathname}${target.search}${separator}${query}`;
      const res = await directRequest({
        method: 'GET',
        url,
        headers: { accept: 'application/dns-json', Host: target.host },
        timeout,
        connectIp: attempt.connectIp,
        servername: attempt.servername,
      });
      const text = await res.text();
      if (res.status !== 200) {
        errors.push(`${target.host}: HTTP ${res.status}`);
        continue;
      }
      const parsed = dohParse(JSON.parse(text));
      if (parsed.v4.length || parsed.v6.length) return { ...parsed, resolver: target.host };
      errors.push(`${target.host}: no answer`);
    } catch (err) {
      errors.push(`${attempt.url}: ${err.code || err.message}`);
    }
  }
  const error = new Error(`the DNS-over-HTTPS resolver did not answer (${errors.join('; ')})`);
  error.code = 'DOH_FAILED';
  throw error;
}
