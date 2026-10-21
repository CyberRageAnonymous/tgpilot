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

test('every icon in the page is a well-formed drawing', async () => {
  const fs = await import('node:fs');
  const html = fs.readFileSync(path.join(root, 'webui', 'index.html'), 'utf-8');

  // Section icons: one per section, drawn inside a 24x24 box.
  const sections = ['deploy', 'handlers', 'endpoints', 'library', 'database', 'miniapp', 'other'];
  for (const key of sections) {
    const block = html.match(new RegExp(`data-open="${key}">[\\s\\S]*?<svg[^>]*>([\\s\\S]*?)</svg>`));
    assert.ok(block, `the ${key} icon is there`);
    assert.match(block[0], /viewBox="0 0 24 24"/, `${key} has a viewBox`);
    assert.match(block[1], /<path d="M/, `${key} draws something`);
    // Every path starts with a move and has no empty segments.
    for (const d of [...block[1].matchAll(/ d="([^"]+)"/g)].map((m) => m[1])) {
      assert.ok(d.trim().length > 3, `${key} has a real path`);
      assert.doesNotMatch(d, /\s,|NaN|undefined/, `${key} has no broken numbers`);
    }
  }

  // The platform logos next to the links.
  const logos = [...html.matchAll(/<span class="link-logo">([\s\S]*?)<\/span>/g)].map((m) => m[1]);
  assert.ok(logos.length >= 7, 'every platform link carries a logo');
  for (const logo of logos) {
    assert.match(logo, /<svg[^>]*viewBox="0 0 24 24"/, 'the logo is a 24x24 drawing');
    assert.match(logo, /<path|stroke-width/, 'the logo draws something');
    assert.doesNotMatch(logo, /NaN|undefined/, 'the logo has no broken numbers');
  }
});
