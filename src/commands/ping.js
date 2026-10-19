import { requestPublic, serverBase, serverErrorText } from '../api/client.js';
import { proxyFromEnv } from '../api/tunnel.js';
import dns from 'node:dns/promises';

// Reads out the machine's situation: which URLs the tool is talking to,
// whether the domain resolves, and whether the cloud answers end-to-end.
// On filtered networks this is where the proxy envs get proven.
export async function registerPing() {
  const base = serverBase();
  const proxy = proxyFromEnv();
  const target = new URL(base);
  const t0 = Date.now();

  console.log(`\n  URL: ${base}`);
  console.log(`  Proxy: ${proxy || '(not set — direct connection)'}`);

  try {
    const addresses = await dns.lookup(target.hostname, { all: true });
    const list = addresses.map((a) => a.address).join(', ');
    console.log(`  ✓ DNS: ${target.hostname} resolves to ${list}`);
  } catch (err) {
    console.log(`  ✗ DNS: ${target.hostname} — ${err.code || err.message}`);
    console.log('');
    console.log('  Reaching the cloud is impossible: resolving the domain failed.');
    console.log('  Hint: set TGPILOT_PROXY=http://host:port (your proxy/VPN app keeps');
    console.log('  its local HTTP port there) and run tgpilot ping again.');
    return 1;
  }

  try {
    await requestPublic('GET', '/capabilities');
    const ms = Date.now() - t0;
    console.log(`  ✓ Reach: the cloud answered in ${ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`}`);
    console.log('');
    console.log('  Everything works. Deploy, run and webhook calls go through here.');
    return 0;
  } catch (err) {
    console.log(`  ✗ Reach: ${serverErrorText(err)}`);
    console.log('');
    return 1;
  }
}
