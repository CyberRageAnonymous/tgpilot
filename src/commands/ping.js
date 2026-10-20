import { requestPublic, serverErrorText } from '../api/client.js';
import { diagnose } from '../project/network.js';
import { familyFromEnv } from '../api/http.js';
import { parseArgs } from '../args.js';

// Reads out the machine's situation: which URL the tool talks to, whether the
// proxy port is alive, whether the domain resolves and whether the cloud
// answers end-to-end.
//
// --probe additionally opens direct connections to the cloud addresses and to
// a DNS-over-HTTPS resolver to find out which route works. Those extra
// connections are not made by default: on a machine watched by a VPN client
// they can disturb the tunnel.
export async function registerPing(argv = []) {
  const args = parseArgs(argv, { flags: ['probe'] });
  const probe = args.flags.probe === true;
  const started = Date.now();
  const { config, steps } = await diagnose({ probe });

  console.log(`\n  URL: ${config.apiUrl || 'https://cloud.telegram.org'}`);
  console.log(`  Proxy: ${config.proxy || '(not set — direct connection)'}`);
  const family = familyFromEnv();
  console.log(`  IP family: ${family === 4 ? 'IPv4 (forced)' : family === 6 ? 'IPv6 (forced)' : 'auto'}`);
  console.log(`  Route probe: ${probe ? 'on (direct connections to the cloud addresses)' : 'off (use --probe to enable)'}`);

  for (const step of steps) {
    console.log(`  ${step.ok ? '✓' : '✗'} ${step.text}`);
    if (step.hint) console.log(`    Hint: ${step.hint}`);
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
