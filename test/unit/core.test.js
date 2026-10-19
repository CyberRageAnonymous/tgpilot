import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, stringify } from '../../src/json5.js';
import { computeDiff } from '../../src/diff.js';
import { changeId, headerTarget, kindLabel } from '../../src/project/changes.js';
import { parseArgs } from '../../src/args.js';
import { plain } from '../../src/colors.js';
import { maskToken, isValidFormat } from '../../src/project/credentials.js';
import { validateDescriptor, sanitizeRelPath, SUPPORTED_SCHEMA_VERSION, MODULE_ROOT } from '../../src/project/layout.js';
import { staticDiff, formatBytes } from '../../src/project/static.js';
import { sameConfig, normalizeConfig } from '../../src/project/config.js';

test('json5: objects, trailing commas, comments, hex', () => {
  const template = `{
    // comment
    text: "hiVoice", /* inline */
    n: 0x1F,
    arr: [1, 2, { a: true, },],
    undef: undefined,
  }`;
  const value = parse(template);
  assert.equal(value.text, 'hiVoice');
  assert.equal(value.n, 31);
  assert.deepEqual(value.arr, [1, 2, { a: true }]);
  assert.equal(value.undef, undefined);
});

test('json5: errors mention line/column', () => {
  assert.throws(() => parse('{ a: }'), /line 1, column/);
});

test('json5: strings keep escaped quotes', () => {
  assert.equal(parse('"a\\"b"'), 'a"b');
  assert.equal(parse("'it\\'s'"), "it's");
});

test('json5: stringify round-trip', () => {
  const original = { a: 1, b: 'x"y', c: [true, null], nested: { z: 'örler' } };
  assert.deepEqual(parse(stringify(original)), original);
});

test('json5: falsey values keep keys', () => {
  const v = parse('{ a: 0, b: false, c: null }');
  assert.deepEqual(v, { a: 0, b: false, c: null });
});

test('diff: unified patch with context', () => {
  const oldText = 'one\n2\nthree\nfour\nfive\nsix\n7\n8\n';
  const newText = 'one\n2\nTHREE\nfour\nfive\nsix\n7\n8\n';
  const patch = computeDiff(oldText, newText, 'x.js');
  assert.match(patch, /^--- a\/x\.js\n\+\+\+ b\/x\.js\n/);
  assert.match(patch, /@@ -3 \+3 @@/);
  assert.match(patch, /-three\n\+THREE/);
});

test('diff: empty string edge', () => {
  const patch = computeDiff('', 'x\n', 'f.js');
  assert.match(patch, /\+x/);
  const back = computeDiff('x\n', '', 'f.js');
  assert.match(back, /-x/);
});

test('changes: ids, targets and labels', () => {
  assert.equal(changeId({ kind: 'create_column', table: 't', column: 'c' }), 'create_column:t.c');
  assert.equal(changeId({ kind: 'undocumented_table', table: 't', index: 'ix' }), 'undocumented_table:t.ix');
  assert.equal(changeId({ kind: 'drop_table', table: 't' }), 'drop_table:t');
  assert.equal(headerTarget({ kind: 'create_index', table: 't', index: 'ix' }), 't.ix');
  assert.equal(kindLabel({ kind: 'create_column' }), 'new column');
});

test('args: flags, values and numbers', () => {
  const out = parseArgs(['a', '--force', '--n', '3', '-x=7', '--'], {
    flags: ['force', 'n', 'x'],
    values: ['n', 'x'],
  });
  out.positional.push('--rest', 'b');
  assert.deepEqual(out.positional, ['a', '--rest', 'b']);
  assert.equal(out.flags.force, true);
  assert.equal(out.values.n, '3');
  assert.equal(out.values.x, '7');
});

test('args: unknown flags throw', () => {
  assert.throws(() => parseArgs(['--nope'], { flags: ['ok'] }), /nope/);
});

test('colors: plain strips ANSI and control characters', async () => {
  process.env.FORCE_COLOR = '1';
  const colors = await import('../../src/colors.js');
  const text = `${colors.c.red('x')}\x1b[31mz\x7fw`;
  assert.equal(colors.plain(text), 'xzw');
  delete process.env.FORCE_COLOR;
});

test('credentials: masking and format checks', () => {
  assert.equal(isValidFormat('app123:ab-9_z'), true);
  assert.equal(isValidFormat('nodigit:abc'), false);
  assert.equal(maskToken('app123:secret'), 'app123');
});

test('layout: descriptor sanitization', () => {
  const valid = validateDescriptor({
    project_schema_version: 1,
    directories: [
      { name: 'handlers', nested: false, synced: true, runnable: true },
      { name: '..', nested: false }, // dropped
      { name: 'extra', allowed_names: ['only', 'BAD!'], },
    ],
    root_files: [{ name: 'schema.js', singleton: true }, { name: '../break.js' }],
    scaffold: ['schema.js', 'handlers/x.js', '../escape'],
    templates: { 'handlers/x.js': 'code', '../../escape.js': 'no' },
  });
  assert.ok(valid);
  assert.equal(valid.directories.length, 2);
  assert.deepEqual(valid.directories[1].allowedNames, ['only']);
  assert.equal(valid.rootFiles.length, 1);
  assert.deepEqual(valid.scaffold, ['schema.js', 'handlers/x.js']);
  assert.ok(valid.templates['handlers/x.js']);
  assert.equal(valid.templates['../../escape.js'], undefined);
});

test('layout: baseline constants', () => {
  assert.equal(SUPPORTED_SCHEMA_VERSION, 1);
  assert.equal(MODULE_ROOT, 'tgcloud');
});

test('layout: relative path sanitizer', () => {
  assert.equal(sanitizeRelPath('handlers/a_b.js'), 'handlers/a_b.js');
  assert.equal(sanitizeRelPath('lib/deep/x.js'), 'lib/deep/x.js');
  assert.equal(sanitizeRelPath('handlers/Main.js'), 'handlers/Main.js');
  assert.equal(sanitizeRelPath('../up.js'), null);
  assert.equal(sanitizeRelPath('tgcloud/handlers/.tgpilot/x.js'), null);
  assert.equal(sanitizeRelPath('handlers/dir/', { allowDir: true }), 'handlers/dir/');
  assert.equal(sanitizeRelPath('handlers/dir/'), null);
});

test('static diff: added/modified/deleted', () => {
  const local = {
    manifest: {
      'keep.js': { hash: 'h1', size: 1 },
      'new.js': { hash: 'h2', size: 2 },
      'mod.js': { hash: 'h3', size: 3 },
    },
  };
  const snapshot = {
    manifest: {
      'keep.js': { hash: 'h1' },
      'mod.js': { hash: 'old' },
      'gone.js': { hash: 'h9' },
    },
    config: { spa: true },
  };
  const d = staticDiff(local, { spa: true }, snapshot);
  assert.deepEqual(d.added, ['new.js']);
  assert.deepEqual(d.modified, ['mod.js']);
  assert.deepEqual(d.deleted, ['gone.js']);
  assert.equal(d.configChanged, false);
  assert.equal(d.changed, true);
});

test('static diff: untouched config compares equal', () => {
  const cfg = normalizeConfig({ spa: true, headers: [{ path: '/a/*', set: { 'X-T': '1' } }] });
  const snapshot = { config: cfg, manifest: {} };
  const d = staticDiff({ manifest: {} }, cfg, snapshot);
  assert.equal(d.configChanged, false);
  assert.equal(d.changed, false);
});

test('config: header sets compare order-insensitively', () => {
  const a = normalizeConfig({ headers: [{ path: '/*', set: { A: '1', B: '2' } }] });
  const b = normalizeConfig({ headers: [{ path: '/*', set: { B: '2', A: '1' } }] });
  assert.equal(sameConfig(a, b), true);
  assert.equal(sameConfig(a, normalizeConfig({})), false);
});

test('config: sameConfig canonical compare', () => {
  assert.equal(sameConfig({ spa: true }, normalizeConfig({ spa: true })), true);
  assert.equal(sameConfig({ spa: true }, normalizeConfig({ spa: false })), false);
});

test('formatBytes', () => {
  assert.equal(formatBytes(5), '5 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(3 * 1024 * 1024), '3.0 MB');
});
