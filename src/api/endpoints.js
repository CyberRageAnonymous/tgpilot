import { request, requestBytes, requestPublic } from './client.js';

// The platform endpoints. Authenticated calls go to /<app id>/manage/<path>.

export async function fetchCapabilities() {
  return requestPublic('GET', '/capabilities');
}

export async function getFiles(token) {
  return request('GET', '/get', token);
}

export async function batchDeploy(token, { expected_revision, manifest, changed_sources, static: staticSection }) {
  const body = {};
  if (manifest !== undefined) {
    body.manifest = manifest;
    body.changed_sources = changed_sources || {};
  }
  if (staticSection !== undefined) body.static = staticSection;
  if (expected_revision != null) body.expected_revision = expected_revision;
  return request('POST', '/deploy', token, body);
}

export async function runFunction(token, moduleName, sources, args, ctx) {
  const body = {
    module: moduleName,
    sources,
    args,
    ctx: ctx || {},
  };
  return request('POST', '/run', token, body);
}

export async function getMigrationStatus(token) {
  return request('GET', '/migrate', token);
}

export async function applyMigration(token, { apply, schema, dry_run = false } = {}) {
  const body = {};
  if (apply != null) body.apply = apply;
  if (schema != null) body.schema = schema;
  if (dry_run) body.dry_run = true;
  return request('POST', '/migrate', token, body);
}

export async function getWebhook(token) {
  return request('GET', '/webhook', token);
}

export async function syncWebhook(token, { drop_pending = false } = {}) {
  const body = {};
  if (drop_pending) body.drop_pending_updates = true;
  return request('POST', '/webhook/sync', token, body);
}

export async function prepareStatic(token, manifest, config) {
  return request('POST', '/static/prepare', token, { manifest, config });
}

export async function uploadBlob(token, hash, bundle, bytes) {
  return requestBytes('PUT', `/static/blob/${hash}?bundle=${bundle}`, token, bytes);
}
