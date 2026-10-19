import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const pkgFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');

let cached = null;

export function readPackageVersion() {
  if (cached != null) return cached;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf-8'));
    cached = pkg.version || '0.0.0';
  } catch {
    cached = '0.0.0';
  }
  return cached;
}
