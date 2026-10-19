import fs from 'fs';
import path from 'path';

// Recognize a front-end project by its package.json, to fill in the `static`
// block when scaffolding. Only Vite-family setups get a source folder here:
// several other frameworks output wherever they like, and guessing wrong is
// worse than asking.
export function detectFrontend(pkg) {
  if (!pkg || typeof pkg !== 'object') return null;
  const deps = {
    ...(pkg.dependencies || {}),
    ...(pkg.devDependencies || {}),
  };
  if ('vite' in deps) {
    return { name: 'vite', source: 'dist', hashedAssets: '/assets/*' };
  }
  return null;
}

export function readPackageJson(root = '.') {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
  } catch {
    return null;
  }
}
