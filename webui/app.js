// Studio front-end. Plain dependency-free JS: fetch the API, draw the views.

const $ = (id) => document.getElementById(id);

const state = {
  view: 'home',
  section: null,
  folderPath: '',
  tree: [],
  handlerTypes: [],
  staticSource: null,
  openPath: null,
  dirty: false,
  migrationIds: [],
  lastStatus: null,
  runnable: ['handlers', 'endpoints'],
  fromView: null,
  editorModule: null,
};

// --- fetch helpers -----------------------------------------------------------

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = { ok: false, error: `bad response (${res.status})` };
  }
  if (!res.ok || body.ok === false) {
    const err = new Error(body.error || `request failed (${res.status})`);
    err.kind = body.kind;
    throw err;
  }
  return body;
}

const GET = (path) => api(path);
const POST = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body || {}) });
const DEL = (path, body) => api(path, { method: 'DELETE', body: JSON.stringify(body || {}) });

function showError(err) {
  if (err.kind === 'auth') refreshProject();
  $('dialog-error-msg').textContent = err.message || String(err);
  $('dialog-error').showModal();
}

function toast(text) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

// --- views -------------------------------------------------------------------

const SECTION_TITLES = {
  home: 'tgpilot studio',
  deploy: 'Deploy & status',
  files: 'Files',
  editor: 'Editor',
  database: 'Database',
};

// The folder each section browses; the cloud module folders live under tgcloud/.
const SECTIONS = {
  handlers: { dir: 'tgcloud/handlers', kind: 'module' },
  endpoints: { dir: 'tgcloud/endpoints', kind: 'module' },
  library: { dir: 'tgcloud/lib', kind: 'module' },
  miniapp: { dir: 'dist', kind: 'file' },
  other: { dir: '', kind: 'file' },
};

function show(view, section) {
  state.view = view;
  state.section = section || null;
  for (const el of document.querySelectorAll('.view')) {
    el.hidden = el.id !== `view-${view}`;
  }
  $('btn-back').hidden = view === 'home';
  $('top-title').textContent = state.section
    ? sectionTitle(state.section)
    : (SECTION_TITLES[view] || 'tgpilot studio');
  window.scrollTo(0, 0);
}

function sectionTitle(key) {
  return ({
    handlers: 'Handlers',
    endpoints: 'Endpoints',
    library: 'Library',
    miniapp: 'Mini App Files',
    other: 'Other files',
  })[key] || SECTION_TITLES.files;
}

function goBack() {
  if (state.view === 'editor') {
    if (state.section) openSection(state.section);
    else if (state.fromView === 'database') show('database');
    else show('home');
    return;
  }
  show('home');
  updateHomeSubs();
}

// Where to land after closing or deleting the open file.
function returnToSection() {
  if (state.section) { openSection(state.section).catch(showError); return; }
  if (state.fromView === 'database') show('database');
  else show('home');
}

// --- boot --------------------------------------------------------------------

function wire() {
  $('btn-back').onclick = goBack;

  for (const row of document.querySelectorAll('.section-row')) {
    row.onclick = () => openSection(row.dataset.open).catch(showError);
  }

  $('btn-link').onclick = () => $('dialog-link').showModal();
  $('btn-link-save').onclick = () => linkBot().catch(showError);
  $('btn-unlink').onclick = () => unlinkBot().catch(showError);

  $('btn-save').onclick = () => saveOpen().catch(showError);
  $('btn-delete').onclick = () => deleteOpen().catch(showError);
  $('btn-run-editor').onclick = () => promptRun(state.editorModule).catch(showError);
  $('btn-run').onclick = () => runCurrent().catch(showError);

  $('btn-new-module').onclick = () => {
    const s = SECTIONS[state.section];
    $('new-module-path').value = s && state.section !== 'other' ? s.dir.replace(/^tgcloud\//, '') + '/' : '';
    $('dialog-new-module').showModal();
    $('new-module-path').focus();
  };
  $('btn-new-module-save').onclick = () => createModule().catch(showError);
  $('btn-new-file').onclick = () => {
    $('new-file-path').value = state.section === 'miniapp' && state.folderPath ? `${state.folderPath}/` : '';
    $('dialog-new-file').showModal();
    $('new-file-path').focus();
  };
  $('btn-new-file-save').onclick = () => createFile().catch(showError);

  $('row-schema').onclick = () => openPath('tgcloud/schema.js').catch(showError);

  $('btn-push').onclick = () => pushPreview().catch(showError);
  $('btn-push-confirm').onclick = () => pushConfirm().catch(showError);
  $('btn-fetch').onclick = () => doFetch().catch(showError);
  $('btn-status').onclick = () => refreshStatus().catch(showError);

  $('btn-migrate-check').onclick = () => migrateCheck().catch(showError);
  $('btn-migrate-recheck').onclick = () => migrateCheck().catch(showError);
  $('btn-migrate-apply').onclick = () => migrateApply().catch(showError);
  $('btn-webhook-sync').onclick = () => webhookSync().catch(showError);
  $('btn-logs-clear').onclick = () => logsClear().catch(showError);
  $('logs-level').onchange = () => loadLogs().catch(() => {});

  const editor = $('editor');
  editor.addEventListener('keydown', onEditorKey);
  editor.addEventListener('input', () => {
    if (!state.openPath) return;
    state.dirty = true;
    $('editor-dirty').hidden = false;
    $('btn-save').disabled = false;
  });

  for (const btn of document.querySelectorAll('[data-close]')) {
    btn.onclick = () => btn.closest('dialog').close();
  }
}

boot();
function boot() {
  wire();
  start().catch(showError);
}

async function start() {
  await Promise.all([refreshProject(), loadTree()]).catch((err) => {
    if (err.kind !== 'auth') throw err;
  });
  await refreshStatus().catch(showError);
  loadLogs().catch(() => {});
  updateHomeSubs();
}

// --- project / bot link ------------------------------------------------------

async function refreshProject() {
  const info = await GET('/api/project');
  state.runnable = info.runnable || ['handlers', 'endpoints'];
  state.staticSource = info.static ? info.static.source : null;
  state.handlerTypes = info.handlerTypes || [];
  const token = info.token;
  $('bot-token').textContent = token ? `bot ${token.masked}` : 'not linked';
  $('bot-token').classList.toggle('linked', Boolean(token));
  $('btn-unlink').hidden = !token;
  $('btn-link').hidden = Boolean(token);
  $('hero-bot').textContent = token ? `bot ${token.masked}` : 'not linked yet — press Link in the corner';
}

async function linkBot() {
  const token = $('link-token').value.trim();
  if (!token) return;
  const out = await POST('/api/bot', { token });
  if (!out.ok) throw new Error(out.error);
  $('link-token').value = '';
  $('dialog-link').close();
  await refreshProject();
  await Promise.all([loadTree(), refreshStatus(), loadLogs()]).catch(showError);
  updateHomeSubs();
}

async function unlinkBot() {
  await DEL('/api/bot');
  await refreshProject();
  await refreshStatus().catch(() => {});
  updateHomeSubs();
}

// --- home subs ---------------------------------------------------------------

function countFilesIn(dir) {
  let n = 0;
  const walk = (nodes) => {
    for (const node of nodes || []) {
      if (node.dir) walk(node.children);
      else if (!dir || node.path.startsWith(`${dir}/`) || node.path === dir) n++;
    }
  };
  walk(state.tree);
  return n;
}

function updateHomeSubs() {
  const linked = $('bot-token').classList.contains('linked');
  const s = state.lastStatus;

  let deploy = linked ? 'open for status, deploy and webhook' : 'link a bot first';
  let deployChip = '';
  if (linked && s) {
    const n = (s.added || []).length + (s.modified || []).length + (s.deleted || []).length
      + (s.static && s.static.changed ? 1 : 0);
    deploy = n === 0 ? 'everything is deployed' : `${n} change${n === 1 ? '' : 's'} waiting to deploy`;
    deployChip = n === 0 ? '✓' : String(n);
  }
  $('sub-deploy').textContent = deploy;
  setChip('cnt-deploy', deployChip, !deployChip);

  const h = countFilesIn('tgcloud/handlers');
  $('sub-handlers').textContent = `${plural(h)} in tgcloud/handlers`;
  setChip('cnt-handlers', state.handlerTypes.length ? `${Math.min(h, state.handlerTypes.length)}/${state.handlerTypes.length}` : '', !h);

  const e = countFilesIn('tgcloud/endpoints');
  $('sub-endpoints').textContent = `${plural(e)} in tgcloud/endpoints`;
  setChip('cnt-endpoints', e ? String(e) : '', !e);

  const l = countFilesIn('tgcloud/lib');
  $('sub-library').textContent = `${plural(l)} in tgcloud/lib`;
  setChip('cnt-library', l ? String(l) : '', !l);

  const db = countFilesIn('tgcloud/schema.js');
  $('sub-database').textContent = db ? 'schema.js — tables and columns live here' : 'no schema.js yet';
  setChip('cnt-database', db ? String(db) : '—', !db);

  const mini = state.staticSource;
  $('sub-miniapp').textContent = mini ? `the build in ${mini}/` : 'not configured — set the static block in tgcloud.jsonc';
  const mf = mini ? countFilesIn(mini) : 0;
  setChip('cnt-miniapp', mf ? String(mf) : (mini ? '' : '—'), !mf);

  $('sub-other').textContent = `${plural(countFilesIn(''))} in the project folder`;
  setChip('cnt-other', String(countFilesIn('')), false);
}

function setChip(id, text) {
  const el = $(id);
  if (!el) return;
  el.textContent = text || '';
  el.classList.toggle('on', Boolean(text && text !== '—'));
}

function plural(n) {
  return `${n} file${n === 1 ? '' : 's'}`;
}

// --- tree cache --------------------------------------------------------------
// The home screen counts live off the tree, so the whole studio reads it once
// and after every change; the section views go through /api/list themselves.

async function loadTree() {
  const out = await GET('/api/tree');
  state.tree = out.tree;
  updateHomeSubs();
}

// Whether tgcloud/schema.js exists decides what the Database row does: edit it,
// or scaffold the same starter the CLI's init writes.
async function initDatabaseView() {
  const out = await GET('/api/list?path=tgcloud');
  const has = out.entries.some((e) => e.name === 'schema.js' && !e.dir);
  const row = $('row-schema');
  row.onclick = has
    ? () => openPath('tgcloud/schema.js').catch(showError)
    : () => createSchema().catch(showError);
  row.querySelector('.file-name').textContent = 'tgcloud/schema.js';
  row.querySelector('.file-sub').textContent = has
    ? 'edit the tables'
    : 'not created yet — one tap builds the starter';
}

async function createSchema() {
  const starter = await GET('/api/starter?kind=schema');
  await POST('/api/file', { path: 'tgcloud/schema.js', content: starter.content });
  toast('tgcloud/schema.js created');
  await loadTree().catch(() => {});
  await openPath('tgcloud/schema.js');
}

// --- sections ----------------------------------------------------------------

async function openSection(key) {
  if (key === 'deploy') {
    show('deploy');
    await Promise.all([refreshStatus().catch(showError), loadWebhook().catch(() => {}), loadLogs().catch(() => {})]);
    return;
  }
  if (key === 'database') {
    show('database');
    initDatabaseView().catch(showError);
    migrateCheck().catch(showError);
    return;
  }

  const s = SECTIONS[key];
  if (!s) return;
  state.section = key;
  state.folderPath = key === 'miniapp' ? (state.staticSource || 'dist') : s.dir;
  const moduleSection = key === 'handlers' || key === 'endpoints' || key === 'library';
  $('btn-new-module').hidden = !moduleSection;
  $('btn-new-file').hidden = moduleSection;
  show('files', key);
  await openFolder(state.folderPath);
}

async function openFolder(rel) {
  state.folderPath = rel;

  const host = $('folder-list');
  host.textContent = '';
  if (rel) {
    const crumb = $('folder-crumb');
    crumb.textContent = '';
    const root = document.createElement('button');
    root.className = 'crumb-item';
    root.textContent = sectionTitle(state.section);
    root.onclick = () => openSection(state.section).catch(showError);
    crumb.appendChild(root);
    for (const part of crumbParts(rel, SECTIONS[state.section].dir)) {
      crumb.appendChild(document.createTextNode(' › '));
      const item = document.createElement('button');
      item.className = 'crumb-item';
      item.textContent = part.name;
      item.onclick = () => openFolder(part.path).catch(showError);
      crumb.appendChild(item);
    }
  } else {
    $('folder-crumb').textContent = '';
  }

  const out = await GET(`/api/list?path=${encodeURIComponent(rel)}`);
  if (!out.entries.length) {
    host.innerHTML = state.section === 'handlers'
      ? '' // the update-type rows follow; an empty handlers folder is normal
      : '<div class="empty">Nothing here yet — the + button creates a starter.</div>';
  }
  for (const entry of out.entries) {
    const path = rel ? `${rel}/${entry.name}` : entry.name;
    const row = document.createElement('button');
    row.className = `file-row ${entry.dir ? 'is-dir' : ''}`;

    const icon = document.createElement('span');
    icon.className = 'file-ico';
    icon.innerHTML = entry.dir
      ? ICONS.folder
      : ICONS.file;
    row.appendChild(icon);

    if (entry.dir) {
      const name = document.createElement('span');
      name.className = 'file-name dir';
      name.textContent = `${entry.name}/`;
      row.appendChild(name);
      const chev = document.createElement('span');
      chev.className = 'chev';
      chev.textContent = '›';
      row.appendChild(chev);
      row.onclick = () => openFolder(path).catch(showError);
    } else {
      const name = document.createElement('span');
      name.className = 'file-name';
      name.textContent = entry.name;
      row.appendChild(name);
      if (entry.size != null) {
        const size = document.createElement('span');
        size.className = 'file-sub';
        size.textContent = formatSize(entry.size);
        row.appendChild(size);
      }
      row.onclick = () => openPath(path).catch(showError);
    }
    host.appendChild(row);
  }

  // The Handlers section is one file per Telegram update type, flat. Show the
  // platform's whole list; types without a file yet become one-tap starters,
  // so the studio mirrors the real panel instead of a plain folder dump.
  if (state.section === 'handlers') {
    const existing = new Set(
      out.entries.filter((e) => !e.dir).map((e) => e.name.replace(/\.js$/, ''))
    );
    for (const t of state.handlerTypes || []) {
      if (existing.has(t.type)) continue;
      const row = document.createElement('button');
      row.className = 'file-row ghost-row';

      const icon = document.createElement('span');
      icon.className = 'file-ico';
      icon.innerHTML = ICONS.file;
      row.appendChild(icon);

      const name = document.createElement('span');
      name.className = 'file-name';
      name.textContent = `${t.type}.js`;
      row.appendChild(name);

      const sub = document.createElement('span');
      sub.className = 'file-sub wide';
      sub.textContent = t.handles;
      row.appendChild(sub);

      const create = document.createElement('span');
      create.className = 'create-chip';
      create.textContent = '+ create';
      row.appendChild(create);

      row.onclick = () => createHandler(t.type).catch(showError);
      host.appendChild(row);
    }
    const more = document.createElement('div');
    more.className = 'empty';
    more.textContent = 'Any other Bot API update type works too — use + module and name the file after it.';
    host.appendChild(more);
  }
}

const ICONS = {
  folder: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 6.5h6l2 2.5h9v8.5a2 2 0 0 1-2 2h-15a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z"/></svg>',
  file: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5h8l4.5 4.5v12a1.5 1.5 0 0 1-1.5 1.5H6a1.5 1.5 0 0 1-1.5-1.5V5A1.5 1.5 0 0 1 6 3.5z"/><path d="M14 3.5V8h4.5"/></svg>',
};

async function createHandler(type) {
  const starter = await GET(`/api/starter?kind=handlers&name=${encodeURIComponent(type)}`);
  const path = `tgcloud/handlers/${type}.js`;
  await POST('/api/file', { path, content: starter.content });
  toast(`handlers/${type} created`);
  await loadTree().catch(() => {});
  await openPath(path);
}

function crumbParts(rel, base) {
  const parts = [];
  let acc = '';
  for (const seg of rel.split('/')) {
    acc = acc ? `${acc}/${seg}` : seg;
    if (!base || acc.startsWith(base)) parts.push({ name: seg, path: acc });
  }
  return parts.filter((p) => p.name);
}

function formatSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// --- editor ------------------------------------------------------------------

function isRunnableModule(path) {
  const match = path.match(/^tgcloud\/([^/]+)\/(.+)\.js$/);
  return Boolean(match && state.runnable.includes(match[1]));
}

async function openPath(path) {
  if (state.dirty && !confirm('Discard unsaved changes?')) return;
  const out = await GET(`/api/file?path=${encodeURIComponent(path)}`);
  state.fromView = state.view;
  state.openPath = path;
  state.dirty = false;
  show('editor');
  $('editor').disabled = false;
  $('editor').value = out.content;
  $('editor-path').textContent = path;
  $('editor-dirty').hidden = true;
  $('btn-save').disabled = false;
  $('btn-delete').disabled = false;
  $('btn-run-editor').hidden = !isRunnableModule(path);
  state.editorModule = path.replace(/^tgcloud\//, '').replace(/\.js$/, '');
}

function onEditorKey(e) {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    saveOpen().catch(showError);
    return;
  }
  if (e.key === 'Tab') {
    e.preventDefault();
    const el = e.target;
    el.setRangeText('  ', el.selectionStart, el.selectionEnd, 'end');
  }
}

async function saveOpen() {
  if (!state.openPath) return;
  await POST('/api/file', { path: state.openPath, content: $('editor').value });
  state.dirty = false;
  $('editor-dirty').hidden = true;
  $('btn-save').disabled = true;
  toast(`saved ${state.openPath}`);
  await Promise.all([loadTree(), refreshStatus()]).catch(showError);
}

async function deleteOpen() {
  if (!state.openPath) return;
  if (!confirm(`Delete ${state.openPath}?`)) return;
  await DEL('/api/file', { path: state.openPath });
  state.openPath = null;
  $('editor').value = '';
  $('editor').disabled = true;
  $('editor-path').textContent = 'no file open';
  $('btn-delete').disabled = true;
  $('btn-save').disabled = true;
  $('btn-run-editor').hidden = true;
  await Promise.all([loadTree(), refreshStatus()]).catch(showError);
  returnToSection();
}

async function createFile() {
  const path = $('new-file-path').value.trim();
  if (!path) return;
  await POST('/api/file', { path, content: '' });
  $('new-file-path').value = '';
  $('dialog-new-file').close();
  await loadTree().catch(() => {});
  await openPath(path);
}

// Modules need a starter; the CLI can add precise server templates, here a
// plain sensible one is enough.
async function createModule() {
  const modPath = $('new-module-path').value.trim().replace(/\.js$/, '');
  if (!modPath) return;
  const base = modPath.split('/').pop();
  const dir = modPath.split('/')[0];
  const starter =
    dir === 'lib' ? `export const ${base} = {};\n` :
    dir === 'endpoints'
      ? 'export default async function main(args, ctx) {\n  return { ok: true };\n}\n'
      : 'export default async function main(args) {\n  console.log("message:", args.text);\n}\n';
  const path = `tgcloud/${modPath}.js`;
  await POST('/api/file', { path, content: starter });
  $('new-module-path').value = '';
  $('dialog-new-module').close();
  await Promise.all([loadTree(), refreshStatus()]);
  await openPath(path);
}

// --- run ---------------------------------------------------------------------

function promptRun(module) {
  if (!module) return;
  $('run-module-name').textContent = module;
  $('run-out').hidden = true;
  $('run-out').textContent = '';
  $('run-args').value = '';
  $('dialog-run').showModal();
  $('run-args').focus();
}

async function runCurrent() {
  const module = $('run-module-name').textContent;
  if (!module) return;
  const argsSrc = $('run-args').value.trim();
  const btn = $('btn-run');
  btn.disabled = true;
  btn.textContent = 'Running…';
  try {
    let args = undefined;
    if (argsSrc) {
      try {
        args = JSON.parse(argsSrc);
      } catch {
        throw new Error('args is not valid JSON — e.g. {"text":"hi"}');
      }
    }
    const out = await POST('/api/run', { module, args });
    renderRunOutput(out, argsSrc, module);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Run';
    loadLogs().catch(() => {});
  }
}

function renderRunOutput(out, argsSrc, module) {
  const parts = [`<span class="head">→ ${escapeHtml(baseName(module))}(${escapeHtml(argsSrc || '')})</span>`];
  for (const entry of out.log || []) {
    const text = String(entry.M != null ? entry.M : (entry.m ?? ''));
    const stamp = entry.t != null ? ` <span class="t">+${escapeHtml(String(entry.t))}s</span>` : '';
    const origin = entry.o ? ` <span class="t">[${escapeHtml(String(entry.o))}]</span>` : '';
    if (entry._ === 'err') parts.push(`<span class="err">${escapeHtml(text)}</span>${stamp}${origin}`);
    else if (entry._ === 'wrn') parts.push(`<span class="wrn">${escapeHtml(text)}</span>${stamp}${origin}`);
    else parts.push(`${escapeHtml(text)}${stamp}${origin}`);
  }
  const isErr = out.result && typeof out.result === 'object' && out.result.__error;
  const value = isErr ? `Error: ${out.result.message || ''}` : '< ' + String(out.result ?? 'undefined');
  parts.push(`<span class="${isErr ? 'err' : 'ret'}">${escapeHtml(value)}${out.time != null ? ` <span class="t">${out.time}s</span>` : ''}</span>`);
  $('run-out').hidden = false;
  $('run-out').innerHTML = parts.join('\n');
}

function baseName(module) {
  return module.includes('/') ? module.slice(module.lastIndexOf('/') + 1) : module;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

// --- status & push -----------------------------------------------------------

async function refreshStatus() {
  const out = await GET('/api/status');
  state.lastStatus = out;
  const box = $('status-box');
  box.textContent = '';

  const line = (cls, text) => {
    const el = document.createElement('div');
    el.className = `line ${cls}`;
    el.textContent = text;
    box.appendChild(el);
  };

  if (!out.token) {
    line('meta', 'not linked — press Link in the corner');
    return out;
  }

  line('meta', out.revision != null ? `revision ${out.revision}` : 'no revision yet');

  for (const p of out.added || []) line('add', `+ ${p}`);
  for (const p of out.modified || []) line('mod', `~ ${p}`);
  for (const p of out.deleted || []) line('del', `− ${p}`);

  const s = out.static || {};
  if (s.changed) {
    for (const p of s.added || []) line('add', `+ ${s.source}/${p}`);
    for (const p of s.modified || []) line('mod', `~ ${s.source}/${p}`);
    for (const p of s.deleted || []) line('del', `− ${s.source}/${p}`);
    if (s.configChanged) line('mod', '~ Mini App serving config');
  }

  const count = (out.added || []).length + (out.modified || []).length + (out.deleted || []).length;
  if (count === 0 && !s.changed) {
    line('ok-badge', '✓ in sync with the bot');
  }
  for (const stray of out.strays || []) line('meta', `⚠ ${stray} is outside the module folders`);
  return out;
}

async function pushPreview() {
  const out = await POST('/api/push');
  if (out.changedCount === 0) {
    $('push-list').innerHTML = '<div class="empty">Nothing to deploy — the folder matches the bot.</div>';
    $('push-confirm-row').hidden = true;
    $('btn-push-confirm').disabled = true;
    $('dialog-push').showModal();
    return;
  }

  const host = $('push-list');
  host.textContent = '';
  const line = (cls, text) => {
    const el = document.createElement('div');
    el.className = `line ${cls}`;
    el.textContent = text;
    host.appendChild(el);
  };
  for (const p of out.added) line('add', `+ ${p}`);
  for (const p of out.modified) line('mod', `~ ${p}`);
  for (const p of out.deleted) line('del', `− ${p}`);
  for (const s of out.static) {
    const text = s.kind === 'remove' ? '− Mini App files (static: false)'
      : s.kind === 'config' ? '~ Mini App serving config'
      : `${s.kind === 'added' ? '+' : s.kind === 'deleted' ? '−' : '~'} ${s.path}`;
    line(s.kind === 'deleted' || s.kind === 'remove' ? 'del' : 'mod', text);
  }
  if (out.schemaTouched) line('meta', 'ℹ schema.js changed — migrations may be pending after deploy');

  const needsDeleteConfirm = out.deletionsRequireConfirm || (out.deleted || []).length > 0;
  $('push-confirm-row').hidden = !needsDeleteConfirm;
  $('btn-push-confirm').disabled = needsDeleteConfirm;
  if (needsDeleteConfirm) {
    $('push-confirm').checked = false;
    $('push-confirm').onchange = () => {
      $('btn-push-confirm').disabled = !$('push-confirm').checked;
    };
  }
  $('dialog-push').showModal();
}

async function pushConfirm() {
  const out = await POST('/api/push', { confirm: true });
  $('dialog-push').close();
  if (out.nothing) {
    toast('nothing to deploy — the folder matches the bot');
    await refreshStatus().catch(() => {});
    updateHomeSubs();
    return;
  }
  const bits = [];
  if (out.revision != null) bits.push(`deployed · revision ${out.revision}`);
  if (out.uploaded) bits.push(`+ ${out.uploaded.count} static file(s) (${out.uploaded.size})`);
  if (out.staticUrl) bits.push(out.staticUrl);
  if (out.dbChanges && out.dbChanges.length) bits.push(`${out.dbChanges.length} DB change(s) pending — check Database`);
  toast(bits.length ? bits.join(' · ') : 'deployed');
  await Promise.all([refreshStatus(), loadLogs()]).catch(() => {});
  updateHomeSubs();
}

async function doFetch() {
  const out = await POST('/api/fetch');
  toast(`snapshot updated — ${out.count} module(s)${out.revision != null ? ` · revision ${out.revision}` : ''}`);
  await refreshStatus();
  updateHomeSubs();
}

// --- migrations --------------------------------------------------------------

async function migrateCheck() {
  const out = await GET('/api/migrate');
  state.migrationIds = out.ids.slice();
  const box = $('migrate-box');
  box.textContent = '';
  if (!out.dbChanges.length) {
    box.innerHTML = '<div class="line ok-badge">✓ database in sync</div>';
    $('migrate-actions').hidden = true;
    return;
  }
  for (let i = 0; i < out.dbChanges.length; i++) {
    const change = out.dbChanges[i];
    const el = document.createElement('div');
    el.className = 'card' + (change.status === 'manual' ? ' negative' : change.status === 'warning' ? ' warn' : '');
    const label = document.createElement('label');
    label.style.display = 'flex';
    label.style.gap = '8px';
    const boxy = document.createElement('input');
    boxy.type = 'checkbox';
    boxy.checked = out.dbChanges.length >= 1 && change.status !== 'manual' && change.status !== 'undocumented';
    boxy.dataset.id = change.id_override !== undefined ? change.id_override : out.ids[i];
    if (change.status === 'manual' || change.status === 'undocumented') boxy.disabled = true;
    const text = document.createElement('span');
    text.textContent = out.cards[i];
    label.appendChild(boxy);
    label.appendChild(text);
    el.appendChild(label);
    box.appendChild(el);
  }
  $('migrate-actions').hidden = false;
}

async function migrateApply() {
  const ids = [...document.querySelectorAll('#migrate-box input[type=checkbox]:checked')].map((cb) => cb.dataset.id);
  if (!ids.length) {
    toast('nothing selected');
    return;
  }
  if (!confirm(`Apply ${ids.length} change(s) to the database?`)) return;
  const out = await POST('/api/migrate', { ids });
  toast(`applied ${out.applied} change(s)`);
  await migrateCheck();
}

// --- webhook -----------------------------------------------------------------

async function loadWebhook() {
  try {
    const out = await GET('/api/webhook');
    renderWebhook(out.webhook);
  } catch (err) {
    $('webhook-box').innerHTML = `<div class="hint">${escapeHtml(err.message || '')}</div>`;
  }
}

async function webhookSync() {
  const out = await POST('/api/webhook', { drop_pending: false });
  renderWebhook(out.webhook);
  toast('webhook synced');
}

function renderWebhook(wh) {
  const box = $('webhook-box');
  box.textContent = '';
  const row = (k, v) => {
    const el = document.createElement('div');
    el.className = 'wh-row';
    el.innerHTML = `<span class="k">${k}</span><span class="v">${escapeHtml(String(v))}</span>`;
    box.appendChild(el);
  };
  row('url', wh.url || '—');
  row('pending', wh.pending_update_count ?? 0);
  if (wh.last_error_message) row('last error', wh.last_error_message);
  const badge = document.createElement('div');
  badge.style.padding = '6px 0 2px';
  badge.innerHTML = wh.in_sync
    ? '<span class="badge ok">✓ in sync</span>'
    : '<span class="badge bad">out of sync — press Sync</span>';
  box.appendChild(badge);
}

// --- journal -----------------------------------------------------------------

async function loadLogs() {
  const level = $('logs-level').value;
  const out = await GET(`/api/logs?level=${level}&limit=120`);
  const box = $('logs-box');
  box.textContent = '';
  for (const entry of out.entries.slice().reverse()) {
    const el = document.createElement('div');
    el.className = 'entry';
    const time = entry.t ? entry.t.slice(11, 19) : '';
    const data = entry.data && JSON.stringify(entry.data) !== '{}' && entry.data !== undefined
      ? JSON.stringify(entry.data)
      : '';
    el.innerHTML = `<span class="t">${time}</span><span class="sc">${escapeHtml(entry.scope || '')}</span>` +
      `<span class="lv-${entry.level}">${escapeHtml(entry.msg)}</span>` +
      (data ? ` <span class="t">${escapeHtml(data.slice(0, 140))}</span>` : '');
    box.appendChild(el);
  }
  if (!out.entries.length) box.innerHTML = '<div class="hint">no entries yet</div>';
}

async function logsClear() {
  await DEL('/api/logs');
  await loadLogs();
}
