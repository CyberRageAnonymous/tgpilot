// Studio front-end. Plain dependency-free JS: fetch the API, draw the panels.

const $ = (id) => document.getElementById(id);

const state = {
  tree: [],
  openPath: null,
  dirty: false,
  migrationIds: [],
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

// --- boot --------------------------------------------------------------------

function wire() {
  $('btn-fetch').onclick = () => doFetch().catch(showError);
  $('btn-status').onclick = () => refreshStatus().catch(showError);

  $('btn-link').onclick = () => $('dialog-link').showModal();
  $('btn-link-save').onclick = () => linkBot().catch(showError);
  $('btn-unlink').onclick = () => unlinkBot().catch(showError);

  $('btn-save').onclick = () => saveOpen().catch(showError);
  $('btn-delete').onclick = () => deleteOpen().catch(showError);

  $('btn-new-module').onclick = () => { $('dialog-new-module').showModal(); $('new-module-path').focus(); };
  $('btn-new-module-save').onclick = () => createModule().catch(showError);
  $('btn-new-file').onclick = () => { $('dialog-new-file').showModal(); $('new-file-path').focus(); };
  $('btn-new-file-save').onclick = () => createFile().catch(showError);

  $('btn-push').onclick = () => pushPreview().catch(showError);
  $('btn-push-confirm').onclick = () => pushConfirm().catch(showError);

  $('btn-run').onclick = () => runModule().catch(showError);
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
}

// --- project / bot link ------------------------------------------------------

async function refreshProject() {
  const info = await GET('/api/project');
  state.runnable = info.runnable || ['handlers', 'endpoints'];
  const token = info.token;
  $('bot-token').textContent = token ? `bot ${token.masked}` : 'not linked';
  $('bot-token').classList.toggle('linked', Boolean(token));
  $('btn-unlink').hidden = !token;
  $('btn-link').hidden = Boolean(token);
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
}

async function unlinkBot() {
  await DEL('/api/bot');
  await refreshProject();
  await refreshStatus().catch(() => {});
}

// --- tree & editor -----------------------------------------------------------

async function loadTree() {
  const out = await GET('/api/tree');
  state.tree = out.tree;
  renderTree($('tree'), out.tree);
  await fillRunModules();
}

function renderTree(host, nodes) {
  host.textContent = '';
  const build = (list, into) => {
    for (const node of list || []) {
      const row = document.createElement('div');
      row.className = `row ${node.dir ? 'dir' : 'file'}`;
      row.textContent = '';

      const chev = document.createElement('span');
      chev.className = 'chev';
      chev.textContent = node.dir ? '▸' : '';
      row.appendChild(chev);

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = node.name + (node.dir ? '/' : '');
      row.appendChild(name);

      if (node.dir) {
        row.onclick = () => row.querySelector('.nested')?.classList.toggle('hidden');
        into.appendChild(row);
        const wrap = document.createElement('div');
        wrap.className = 'nested';
        build(node.children, wrap);
        into.appendChild(wrap);
      } else {
        row.onclick = () => {
          host.querySelectorAll('.row.active').forEach((el) => el.classList.remove('active'));
          row.classList.add('active');
          openPath(node.path).catch(showError);
        };
        into.appendChild(row);
      }
    }
  };
  build(nodes, host);
}

async function openPath(path) {
  if (state.dirty && !confirm('Discard unsaved changes?')) return;
  const out = await GET(`/api/file?path=${encodeURIComponent(path)}`);
  state.openPath = path;
  state.dirty = false;
  $('editor').disabled = false;
  $('editor').value = out.content;
  $('editor-path').textContent = path;
  $('editor-dirty').hidden = true;
  $('btn-save').disabled = false;
  $('btn-delete').disabled = false;
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
  await Promise.all([loadTree(), refreshStatus()]).catch(showError);
}

async function createFile() {
  const path = $('new-file-path').value.trim();
  if (!path) return;
  await POST('/api/file', { path, content: '' });
  $('new-file-path').value = '';
  $('dialog-new-file').close();
  await loadTree();
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
  const path = `${modPath}.js`;
  await POST('/api/file', { path, content: starter });
  $('new-module-path').value = '';
  $('dialog-new-module').close();
  await Promise.all([loadTree(), refreshStatus()]);
  await openPath(path);
}

// --- status & push -----------------------------------------------------------

async function refreshStatus() {
  const out = await GET('/api/status');
  const box = $('status-box');
  box.textContent = '';

  const line = (cls, text) => {
    const el = document.createElement('div');
    el.className = `line ${cls}`;
    el.textContent = text;
    box.appendChild(el);
  };

  if (!out.token) {
    line('meta', 'not linked — press "Link bot…"');
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
    if (s.configChanged) line('mod', '~ static serving config');
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
  const bits = [];
  if (out.revision != null) bits.push(`deployed · revision ${out.revision}`);
  if (out.uploaded) bits.push(`+ ${out.uploaded.count} static file(s) (${out.uploaded.size})`);
  if (out.staticUrl) bits.push(out.staticUrl);
  if (out.dbChanges && out.dbChanges.length) bits.push(`${out.dbChanges.length} DB change(s) pending — check Migrations`);
  toast(bits.length ? bits.join(' · ') : 'deployed');
  await Promise.all([refreshStatus(), loadLogs()]).catch(() => {});
}

async function doFetch() {
  const out = await POST('/api/fetch');
  toast(`snapshot updated — ${out.count} module(s)${out.revision != null ? ` · revision ${out.revision}` : ''}`);
  await refreshStatus();
}

// --- run ---------------------------------------------------------------------

async function fillRunModules() {
  const sel = $('run-module');
  sel.textContent = '';
  const runnable = new Set(state.runnable || []);
  const collect = (nodes, prefix) => {
    for (const node of nodes || []) {
      if (node.dir) collect(node.children, `${prefix}${node.name}/`);
      else if (node.name.endsWith('.js') && runnable.has(prefix.split('/')[0])) {
        const option = document.createElement('option');
        option.value = `${prefix}${node.name}`.replace(/\.js$/, '');
        option.textContent = option.value;
        sel.appendChild(option);
      }
    }
  };
  collect(state.tree, '');
  if (!sel.options.length) {
    sel.innerHTML = '<option value="">no runnable modules yet</option>';
    $('btn-run').disabled = true;
  } else {
    $('btn-run').disabled = false;
  }
}

async function runModule() {
  const module = $('run-module').value;
  if (!module) return;
  const args = $('run-args').value.trim();
  const out = await POST('/api/run', { module, args: args || undefined });

  const escLike = escapeHtml;
  const parts = [`<span class="head">→ ${escLike(baseName(module))}(${escLike(args || '')})</span>`];
  for (const entry of out.log || []) {
    const text = String(entry.M != null ? entry.M : (entry.m ?? ''));
    const stamp = entry.t != null ? ` <span class="t">+${escLike(String(entry.t))}s</span>` : '';
    const origin = entry.o ? ` <span class="t">[${escLike(String(entry.o))}]</span>` : '';
    if (entry._ === 'err') parts.push(`<span class="err">${escLike(text)}</span>${stamp}${origin}`);
    else if (entry._ === 'wrn') parts.push(`<span class="wrn">${escLike(text)}</span>${stamp}${origin}`);
    else parts.push(`${escLike(text)}${stamp}${origin}`);
  }
  const isErr = out.result && typeof out.result === 'object' && out.result.__error;
  const value = isErr ? `Error: ${out.result.message || ''}` : '< ' + String(out.result ?? 'undefined');
  parts.push(`<span class="${isErr ? 'err' : 'ret'}">${escLike(value)}${out.time != null ? ` <span class="t">${out.time}s</span>` : ''}</span>`);
  $('run-out').hidden = false;
  $('run-out').innerHTML = parts.join('\n');
}

function baseName(module) {
  return module.includes('/') ? module.slice(module.lastIndexOf('/') + 1) : module;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
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
