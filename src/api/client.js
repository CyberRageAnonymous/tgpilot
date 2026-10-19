const PROD_URL = 'https://cloud.telegram.org';

function apiBase() {
  const override = process.env.TGPILOT_API_URL || process.env.TG_CLOUD_API_URL;
  return (override || PROD_URL).replace(/\/+$/, '');
}

export function serverBase() {
  return process.env.TGPILOT_BETA === '1' ? `${apiBase()}/beta` : apiBase();
}

function isDebug() {
  return process.env.TGPILOT_DEBUG === '1' || process.env.TGCLOUD_DEBUG === '1';
}

export function extractAppId(token) {
  const parts = String(token).split(':');
  if (parts.length !== 2 || !/^app\d+$/.test(parts[0])) {
    throw new Error('Invalid token format. Expected "app<id>:<secret>".');
  }
  return parts[0];
}

export async function request(method, path, token, body) {
  const appId = extractAppId(token);
  const url = `${serverBase()}/${appId}/manage${path}`;

  if (isDebug()) {
    console.error(`\n[debug] → ${method} ${url}`);
    console.error(`[debug]   Authorization: Bearer ${appId}:***`);
    if (body !== undefined) {
      console.error('[debug]   body:', JSON.stringify(body, null, 2));
    }
  }

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return parseEnvelope(res);
}

export async function requestBytes(method, path, token, bytes) {
  const appId = extractAppId(token);
  const url = `${serverBase()}/${appId}/manage${path}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(bytes.length),
  };

  if (isDebug()) {
    console.error(`\n[debug] → ${method} ${url}`);
    console.error(`[debug]   Authorization: Bearer ${appId}:***`);
    console.error(`[debug]   body: <${bytes.length} bytes>`);
  }

  const res = await fetch(url, { method, headers, body: bytes });
  return parseEnvelope(res);
}

export async function requestPublic(method, path) {
  const url = `${serverBase()}${path}`;
  if (isDebug()) {
    console.error(`\n[debug] → ${method} ${url} (public)`);
  }
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' } });
  return parseEnvelope(res);
}

async function parseEnvelope(res) {
  const rawText = await res.text();

  if (isDebug()) {
    console.error(`[debug] ← HTTP ${res.status} ${res.statusText}`);
    console.error(`[debug]   body: ${rawText.length ? rawText : '(empty)'}`);
  }

  let data;
  try {
    data = JSON.parse(rawText);
  } catch {
    const err = new Error(`Invalid response from the server (HTTP ${res.status}).`);
    err.status = res.status;
    throw err;
  }

  if (typeof data !== 'object' || data === null || data.ok === undefined) {
    throw new Error('Invalid response format: expected { ok, result }.');
  }

  if (!data.ok) {
    const err = new Error(data.description || data.error || `Server error (HTTP ${res.status}).`);
    err.description = data.description;
    err.code = data.error_code ?? data.error;
    err.type = typeof data.error_type === 'string' ? data.error_type : undefined;
    err.status = res.status;
    err.parameters = data.parameters || {};
    throw err;
  }

  return data.result;
}

// One-line, user-facing description of a server error.
export function serverErrorText(err) {
  if (
    err &&
    err.status == null &&
    (err.name === 'TypeError' ||
      /fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|UND_ERR/i.test(
        err.cause?.code || err.message || ''
      ))
  ) {
    return (
      `Could not reach the server at ${serverBase()}. ` +
      'Check your connection (or the TGPILOT_API_URL setting).'
    );
  }

  let msg = err?.description || err?.message || 'Server error.';
  const mod = err?.parameters?.module;
  if (mod && !msg.includes(mod)) msg += ` (module: ${mod})`;
  const p = err?.parameters || {};
  const keys = ['path', 'paths', 'field', 'rule', 'index', 'pattern', 'name', 'from', 'to', 'file', 'reason', 'limit', 'max'];
  const where = keys
    .filter((k) => p[k] !== undefined && !msg.includes(String(p[k])))
    .map((k) => `${k}: ${Array.isArray(p[k]) ? p[k].join(', ') : p[k]}`);
  if (where.length) msg += ` (${where.join(', ')})`;
  return stripControl(msg);
}

// Terminal output protects itself: a response string cannot inject escape
// sequences, so they are stripped before printing.
export function stripControl(s) {
  return String(s).replace(/[\x00-\x1f\x7f]/g, '');
}
