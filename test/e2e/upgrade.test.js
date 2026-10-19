import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { startMockCloud, stopMockCloud, Project } from './helpers/helpers.js';

let cloud;

test.after(async () => {
  if (cloud) await stopMockCloud(cloud);
});

test.before(async () => {
  cloud = await startMockCloud();
});

test('upgrade moves a legacy layout under tgcloud/', async () => {
  const proj = new Project(cloud, null, 'upgrade');
  proj.write('schema.js', 'export const marker = 1;\n');
  proj.write('handlers/message.js', 'export default async function (m, c) { return 1; }\n');

  const dry = await proj.cli(['upgrade', '--dry-run']);
  assert.equal(dry.code, 0, dry.out);
  assert.match(dry.out, /dry-run/);
  assert.ok(proj.exists('schema.js'));
  assert.ok(proj.exists('handlers/message.js'));

  const r = await proj.cli(['upgrade']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Moved 2 files under tgcloud\/\./);
  assert.ok(proj.exists('tgcloud/schema.js'));
  assert.equal(proj.read('tgcloud/schema.js'), 'export const marker = 1;\n');
  assert.ok(proj.exists('tgcloud/handlers/message.js'));
  assert.ok(!proj.exists('schema.js'));

  const again = await proj.cli(['upgrade']);
  assert.equal(again.code, 0, again.out);
  assert.match(again.out, /already uses the current layout|Nothing to move\./);
});

test('status refuses to run in a legacy layout, upgrade unlocks it', async () => {
  const proj = new Project(cloud, null, 'legacy');
  proj.write('schema.js', 'export const marker = 1;\n');
  const bad = await proj.cli(['status']);
  assert.match(bad.out, /old layout|upgrade/);
  await proj.cli(['upgrade']);
  const ok = await proj.cli(['status']);
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /No local snapshot yet/i);
});

test('path.join behaves with nested projects (sanity of helpers)', () => {
  const proj = new Project(cloud, null, 'sanity');
  proj.write('tgcloud/lib/deep/x.js', '// deep\n');
  assert.ok(proj.exists(path.join('tgcloud', 'lib', 'deep', 'x.js')));
  assert.equal(fs.readFileSync(path.join(proj.dir, 'tgcloud/lib/deep/x.js'), 'utf-8'), '// deep\n');
});
