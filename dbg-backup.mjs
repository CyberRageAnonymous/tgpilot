import { pathToFileURL } from 'node:url';
const h = await import(pathToFileURL('/home/server/tgpilot/test/e2e/helpers/helpers.js').href);
const cloud = await h.startMockCloud();
const token = cloud.mintToken();
const proj = new h.Project(cloud, token, 'dbg-backup');
proj.write('tgcloud/handlers/message.js', 'export default async function (message, ctx) { return 1; }\n');
const port = await h.freePort();
const child = await h.startStudio(proj, port);
child.stdout.on('data', (c) => process.stdout.write('[out] ' + c));
child.stderr.on('data', (c) => process.stdout.write('[err] ' + c));
for (const p of ['/api/backups', '/api/project', '/api/tree']) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`).then(async (r) => [r.status, (await r.text()).slice(0, 160)]);
  console.log(p, '→', res[0], res[1]);
}
child.kill('SIGTERM');
process.exit(0);
