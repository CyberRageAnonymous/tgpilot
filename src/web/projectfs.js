import fs from 'fs';
import path from 'path';

// File-access guards for the studio: reads and writes stay inside the
// project folder, dot-directories stay out, and sizes are bounded.

const FORBIDDEN = new Set(['.tgpilot', '.tgcloud', '.git', 'node_modules']);
const MAX_READ = 2 * 1024 * 1024;
const MAX_WRITE = 4 * 1024 * 1024;

export function createProjectFs(root) {
  const ROOT = path.resolve(root);

  const deny = (message) => { const err = new Error(message); err.status = 400; return err; };

  const safePath = (rel) => {
    const posix = String(rel || '').split(/[\\/]/).join('/');
    if (!posix || posix === '.' || posix.startsWith('/') || posix.startsWith('~')) throw deny('Bad path');
    const segments = posix.split('/').filter((s) => s && s !== '.');
    for (const seg of segments) {
      if (!seg || seg === '.' || seg === '..') throw deny('Bad path');
      if (FORBIDDEN.has(seg)) throw deny(`"${seg}" is off limits for the studio`);
    }
    const abs = path.join(ROOT, ...segments);
    if (!abs.startsWith(ROOT + path.sep)) throw deny('Outside the project folder');
    return abs;
  };

  return {
    root: ROOT,
    read(rel) {
      const abs = safePath(rel);
      const st = fs.statSync(abs);
      if (st.isDirectory()) throw deny('That is a folder');
      if (st.size > MAX_READ) throw deny('File too large for the studio (>2 MB)');
      return fs.readFileSync(abs, 'utf-8');
    },
    list(rel) {
      const abs = safePath(rel || '.');
      const entries = [];
      for (const name of fs.readdirSync(abs)) {
        if (FORBIDDEN.has(name)) continue;
        let st;
        try {
          st = fs.statSync(path.join(abs, name));
        } catch {
          continue;
        }
        if (st.isDirectory() || st.isFile()) {
          entries.push({
            name,
            dir: st.isDirectory(),
            size: st.isFile() ? st.size : undefined,
          });
        }
      }
      entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
      return entries;
    },
    write(rel, content) {
      const abs = safePath(rel);
      const body = String(content == null ? '' : content);
      if (Buffer.byteLength(body, 'utf-8') > MAX_WRITE) throw deny('File too large for the studio (>4 MB)');
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, body);
    },
    remove(rel) {
      const abs = safePath(rel);
      const st = fs.statSync(abs);
      if (st.isDirectory()) {
        fs.rmdirSync(abs); // empty folders only; refused when not empty
        return;
      }
      fs.unlinkSync(abs);
    },
  };
}
