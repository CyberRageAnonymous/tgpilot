import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Parses the shipped studio files so a markup regression (a mangled row, a
// dangling $('id')) can never reach a user again.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const html = () => readFileSync(path.join(root, 'webui/index.html'), 'utf8');
const js = () => readFileSync(path.join(root, 'webui/app.js'), 'utf8');

test('every id the studio script touches exists in the markup', () => {
  const used = [...js().matchAll(/\$\(\s*['"]([\w-]+)['"]\s*\)/g)].map((m) => m[1]);
  const defined = new Set([...html().matchAll(/id=["']([\w-]+)["']/g)].map((m) => m[1]));
  const missing = [...new Set(used)].filter((id) => !defined.has(id));
  assert.deepEqual(missing, [], `ids used in app.js but missing from index.html: ${missing.join(', ')}`);
});

test('the home section rows are intact', () => {
  const keys = ['deploy', 'handlers', 'endpoints', 'library', 'database', 'miniapp', 'other'];
  for (const key of keys) {
    const row = html().match(new RegExp(`<button class="section-row" data-open="${key}">([\\s\\S]*?)</button>`));
    assert.ok(row, `section row ${key} is missing or malformed`);
    assert.equal(row[1].split('{').length, row[1].split('}').length, `balanced tags in row ${key}`);
    assert.match(row[1], /section-icon/);
    assert.match(row[1], /section-title/);
    assert.match(row[1], new RegExp(`id="sub-${key}"`));
    assert.match(row[1], new RegExp(`id="cnt-${key}"`));
    assert.match(row[1], /chev/);
  }
});
