import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import { fileURLToPath } from 'url';
import { createMockCloud } from '../../helpers/mock-cloud.js';

// Every e2e scenario runs the real CLI (`bin/tgpilot.js`) against an in-process
// mock cloud, in a throwaway project folder. State lives in `.tgpilot/` there.

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const BIN = path.join(ROOT, 'bin', 'tgpilot.js');

export async function startMockCloud() {
  const cloud = createMockCloud();
  await new Promise((resolve) => {
    cloud.server.listen(0, '127.0.0.1', resolve);
  });
  cloud.port = cloud.server.address().port;
  cloud.baseUrl = `http://127.0.0.1:${cloud.port}`;
  return cloud;
}

export class Project {
  constructor(cloud, token, name = 'proj') {
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), `tgpilot-${name}-`));
    this.baseUrl = cloud.baseUrl;
    this.env = {
      ...process.env,
      TGPILOT_API_URL: cloud.baseUrl,
      TGPILOT_ASSUME_TTY: '1',
      NO_COLOR: '1',
      ...(token ? { TGPILOT_TOKEN: token } : {}),
    };
  }

  cli(args, { input = '', token } = {}) {
    // Async on purpose: the mock cloud serves from this same event loop, so a
    // blocking spawnSync here would deadlock every command.
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [BIN, ...args], {
        cwd: this.dir,
        env: token ? { ...this.env, TGPILOT_TOKEN: token } : this.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.stdout.setEncoding('utf-8');
      child.stderr.setEncoding('utf-8');
      let out = '';
      let err = '';
      child.stdout.on('data', (chunk) => { out += chunk; });
      child.stderr.on('data', (chunk) => { err += chunk; });
      child.stdin.write(input);
      child.stdin.end();
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
      }, 60000);
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, out: out + err, stdout: out, stderr: err });
      });
    });
  }

  write(rel, content) {
    const full = path.join(this.dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }

  read(rel) {
    return fs.readFileSync(path.join(this.dir, rel), 'utf-8');
  }

  exists(rel) {
    return fs.existsSync(path.join(this.dir, rel));
  }

  state() {
    return JSON.parse(this.read(path.join('.tgpilot', 'state.json')));
  }
}

// Release the port and any lingering sockets so the test process can exit.
export function stopMockCloud(cloud) {
  return new Promise((resolve) => {
    cloud.server.closeAllConnections && cloud.server.closeAllConnections();
    cloud.server.close(() => resolve());
  });
}

// Same mechanics, but a persistent child process for the studio web server.
export function startStudio(proj, port) {  const child = spawn(process.execPath, [BIN, 'web', '--port', String(port)], {
    cwd: proj.dir,
    env: proj.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf-8');
  child.stderr.setEncoding('utf-8');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('studio did not start')), 8000);
    const onData = (chunk) => {
      if (chunk.includes('studio → http://')) {
        clearTimeout(timer);
        resolve(child);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
  });
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}
