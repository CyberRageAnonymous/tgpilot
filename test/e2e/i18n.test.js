import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startMockCloud, stopMockCloud, Project, startStudio, freePort } from './helpers/helpers.js';

let cloud;
let token;

test.after(async () => {
  if (cloud) await stopMockCloud(cloud);
});

test.before(async () => {
  cloud = await startMockCloud();
  token = cloud.mintToken();
});

const api = async (port, path, { method = 'GET', body } = {}) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, text, json };
};

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');

test('the studio serves its translations, settings and manual', async () => {
  const port = await freePort();
  const proj = new Project(cloud, token, 'i18n');
  proj.write('tgcloud/handlers/message.js', 'export default async function (message, ctx) { return 1; }\n');
  const child = await startStudio(proj, port);
  try {
    for (const file of ['/i18n.js', '/settings.js', '/help.js']) {
      const res = await fetch(`http://127.0.0.1:${port}${file}`);
      assert.equal(res.status, 200, file);
      assert.match(res.headers.get('content-type'), /javascript/, file);
    }

    const dictionaries = await fetch(`http://127.0.0.1:${port}/i18n.js`).then((r) => r.text());
    for (const language of ['en', 'fa', 'zh', 'ru']) {
      assert.match(dictionaries, new RegExp(`const ${language} = {`), `the ${language} dictionary is there`);
    }
    // Every language fills the same keys.
    const keys = (language) => {
      const block = dictionaries.slice(dictionaries.indexOf(`const ${language} = {`));
      const end = block.indexOf('\n};');
      return [...block.slice(0, end).matchAll(/'([\w.]+)':/g)].map((m) => m[1]);
    };
    const english = keys('en');
    assert.ok(english.length > 80, 'the English dictionary is complete');
    for (const language of ['fa', 'zh', 'ru']) {
      const other = keys(language);
      const missing = english.filter((key) => !other.includes(key));
      assert.deepEqual(missing, [], `the ${language} dictionary is missing keys`);
    }
  } finally {
    child.kill('SIGTERM');
  }
});

test('the manual is written in all four languages', async () => {
  const manual = fs.readFileSync(path.join(root, 'webui', 'help.js'), 'utf-8');
  for (const language of ['en', 'fa', 'zh', 'ru']) {
    assert.match(manual, new RegExp(`^  ${language}: \\[`, 'm'), `the ${language} manual is there`);
  }
  // The Persian manual really is Persian.
  const persian = manual.slice(manual.indexOf('  fa: ['), manual.indexOf('  zh: ['));
  assert.match(persian, /[؀-ۿ]/, 'the Persian manual is written in Persian');
  const chinese = manual.slice(manual.indexOf('  zh: ['), manual.indexOf('  ru: ['));
  assert.match(chinese, /[一-鿿]/, 'the Chinese manual is written in Chinese');
  const russian = manual.slice(manual.indexOf('  ru: ['));
  assert.match(russian, /[а-яА-Я]/, 'the Russian manual is written in Russian');
});

test('every marked string in the page has a translation', async () => {
  const html = fs.readFileSync(path.join(root, 'webui', 'index.html'), 'utf-8');
  const dictionaries = fs.readFileSync(path.join(root, 'webui', 'i18n.js'), 'utf-8');
  const englishBlock = dictionaries.slice(dictionaries.indexOf('const en = {'));
  const english = new Set([...englishBlock.slice(0, englishBlock.indexOf('\n};')).matchAll(/'([\w.]+)':/g)].map((m) => m[1]));
  const used = [...html.matchAll(/data-i18n(?:-placeholder|-title)?="([\w.]+)"/g)].map((m) => m[1]);
  assert.ok(used.length > 40, 'the page marks its strings');
  const missing = [...new Set(used)].filter((key) => !english.has(key));
  assert.deepEqual(missing, [], `strings without a translation: ${missing.join(', ')}`);
});

test('the studio keeps a backup before a push when it is asked to', async () => {
  const port = await freePort();
  const proj = new Project(cloud, cloud.mintToken(), 'push-backup');
  proj.write('tgcloud/handlers/message.js', 'export default async function (message, ctx) { return 1; }\n');
  const child = await startStudio(proj, port);
  try {
    const before = await api(port, '/api/backups');
    assert.equal(before.json.backups.length, 0);

    const pushed = await api(port, '/api/push', { method: 'POST', body: { confirm: true, backup: true } });
    assert.equal(pushed.status, 200, pushed.text);

    const after = await api(port, '/api/backups');
    assert.equal(after.json.backups.length, 1, 'the push left a backup behind');
    assert.match(after.json.backups[0].id, /before-push/);
  } finally {
    child.kill('SIGTERM');
  }
});
