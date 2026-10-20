import { requestPublic, serverBase, serverErrorText } from '../api/client.js';
import { proxyFromEnv } from '../api/tunnel.js';
import dns from 'node:dns/promises';
import net from 'node:net';

// Reads out the machine's situation: which URL the tool talks to, whether the
// proxy port is alive, whether the domain resolves, and whether the cloud
// answers end-to-end. On filtered networks this is where the truth shows up.
export async function registerPing() {
  const base = serverBase();
  const proxy = proxyFromEnv();
  const target = new URL(base);
  const started = Date.now();

  console.log(`\n  URL: ${base}`);
  console.log(`  Proxy: ${proxy || '(not set — direct connection)'}`);

  if (proxy) {
    const alive = await proxyPortAlive(proxy);
    if (alive === true) console.log(`  ✓ Proxy: the port answers (${proxy})`);
    else if (alive === false) {
      console.log(`  ✗ Proxy: nothing is listening on ${proxy}`);
      console.log('');
      console.log('  Start your proxy/VPN app, or correct the port in TGPILOT_PROXY.');
      return 1;
    }
  }

  let addresses = [];
  try {
    addresses = (await dns.lookup(target.hostname, { all: true })).map((a) => a.address);
    console.log(`  ✓ DNS: ${target.hostname} resolves to ${addresses.join(', ')}`);
  } catch (err) {
    console.log(`  ✗ DNS: ${target.hostname} — ${err.code || err.message}`);
    console.log('');
    console.log('  Reaching the cloud is impossible: the domain does not resolve.');
    console.log('  Hint: set TGPILOT_PROXY=http://host:port (your proxy/VPN app keeps');
    console.log('  its local HTTP port there) and run tgpilot ping again.');
    return 1;
  }

  const poisoned = addresses.filter((ip) => isPrivate(ip));
  if (poisoned.length) {
    console.log(`  ! DNS: ${poisoned.join(', ')} is a private address — that usually means a filtered or hijacked DNS answer.`);
    console.log('    A direct connection will not get through; use a proxy.');
  }

  try {
    await requestPublic('GET', '/capabilities');
    const ms = Date.now() - started;
    console.log(`  ✓ Reach: the cloud answered in ${ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`}`);
    console.log('');
    console.log('  Everything works. Deploy, run and webhook calls go through here.');
    return 0;
  } catch (err) {
    console.log(`  ✗ Reach: ${serverErrorText(err)}`);
    if (err?.hint) console.log(`    Hint: ${err.hint}`);
    console.log('');
    return 1;
  }
}

// A proxy that is not running is the most common reason for a failure, so it
// gets its own check: is anything listening on that port at all?
async function proxyPortAlive(proxy) {
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

function isPrivate(ip) {
  if (ip.startsWith('10.') || ip.startsWith('192.168.') || ip.startsWith('127.')) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  if (ip.startsWith('169.254.')) return true;
  return false;
}
