import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from '../args.js';
import { fatal, info } from '../output.js';
import { log } from '../logs.js';
import { findProjectRoot } from '../project/root.js';
import { MODULE_ROOT } from '../project/layout.js';
import { createRoutes } from '../web/routes.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEBUI_DIR = path.join(HERE, '..', '..', 'webui');
const DEFAULT_PORT = 5177;

export async function registerWeb(argv) {
  const args = parseArgs(argv, { values: ['port', 'host'] });

  // The studio browses the project folder, so it refuses to serve anything else:
  // a stray .tgpilot higher up would otherwise pose as the project.
  const root = findProjectRoot();
  if (!root || !fs.existsSync(path.join(root, MODULE_ROOT))) {
    fatal('No project folder found. cd into one (e.g. "cd mybot") or run "tgpilot init" first.');
  }

  const port = args.values.port ? Number(args.values.port) : Number(process.env.TGPILOT_WEB_PORT) || DEFAULT_PORT;
  const host = String(process.env.TGPILOT_WEB_HOST || args.values.host || '127.0.0.1');

  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    fatal(`Bad port: ${args.values.port}`);
  }

  const uiDir = fs.existsSync(WEBUI_DIR) ? WEBUI_DIR : null;
  const routes = createRoutes(root, uiDir);

  const server = http.createServer((req, res) => {
    routes({ req, res }, () => {
      // Anything unmatched: serve the studio UI for the top level, 404 otherwise.
      if (uiDir && (req.method === 'GET' || req.method === 'HEAD') && (req.url === '/' || !req.url.startsWith('/api/'))) {
        // The studio is a small set of files; anything that is not one of
        // them gets the page itself.
        const file = req.url.split('?')[0].replace(/^\//, '');
        if (['i18n.js', 'settings.js', 'help.js', 'app.js', 'style.css'].includes(file)) {
          return serveFile(uiDir, file, res);
        }
        return serveFile(uiDir, 'index.html', res);
      }
      notFound(res);
    });
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      fatal(`Port ${port} is busy — is another tgpilot web studio running? Use --port to pick another.`);
    }
    fatal(err.message);
  });

  await new Promise((resolve) => {
    server.listen(port, host, resolve);
  });

  // The studio is a long-running process in front of a browser. A single
  // unexpected error must never take it down: log it and keep serving.
  process.on('unhandledRejection', (err) => {
    log('error', 'web', 'Something went wrong in the background; the studio keeps running.', {
      error: err?.message || String(err),
    });
  });
  process.on('uncaughtException', (err) => {
    log('error', 'web', 'Unexpected error in the studio; the studio keeps running.', {
      error: err?.message || String(err),
    });
  });

  info(`tgpilot studio → http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
  info('It serves only this machine. The bot token never reaches the browser.');
  info('Press Ctrl+C to stop.');
  return new Promise(() => {});
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

function serveFile(dir, name, res) {
  const full = path.join(dir, name);
  if (!fs.existsSync(full)) return notFound(res);
  const type = CONTENT_TYPES[path.extname(name)] || 'text/plain; charset=utf-8';
  res.writeHead(200, { 'Content-Type': type });
  res.end(fs.readFileSync(full));
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('not found');
}
