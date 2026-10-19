import { parseArgs } from '../args.js';
import { info, success, fatal } from '../output.js';
import { syncCapabilities, resetLayout, moduleDirs, nestableDirs, directoryFor, templates, sanitizeRelPath } from '../project/layout.js';
import { toModulePath, writeDisk, existsDisk, displayPath } from '../project/workdir.js';
import { moduleStarter } from '../templates.js';
import { log } from '../logs.js';

// Server-provided directory templates may still reference the leaf and module
// name through these tokens; bundled starters have the name already.
const NAME_TOKEN = /\$\$BASENAME\$\$/g;
const MODULE_TOKEN = /\$\$MODULE\$\$/g;

export async function registerAdd(argv) {
  const args = parseArgs(argv, {});
  const target = args.positional[0];

  if (target === undefined) {
    fatal('Missing a target: "tgpilot add handlers/callback_query", for example.');
  }

  await syncCapabilities();
  resetLayout();

  // Targets look like "handlers/message", "lib/cart" or "lib/internal/cart";
  // an optional .js or the tgcloud/ prefix is accepted, a lone directory is
  // answered with the names still free.
  const stripped = toModulePath(target).replace(/\.js$/i, '').replace(/\/+$/, '');
  const segments = stripped.split('/').filter(Boolean);
  if (!segments.length) fatal(`Invalid target: ${target}`);

  const [dir, ...leafSegs] = segments;
  const dirs = moduleDirs();
  if (!dirs.includes(dir)) {
    fatal(`"${dir}/" is not a module directory. Choose from: ${dirs.map((d) => `${d}/`).join(', ')}.`);
  }

  const descriptor = directoryFor(dir);
  if (leafSegs.length === 0) {
    const allowed = descriptor?.allowedNames;
    if (allowed && allowed.length) {
      const free = allowed.filter((n) => !existsDisk(`${dir}/${n}.js`));
      if (free.length === 0) fatal(`Every ${dir}/ module already exists.`);
      fatal(`Say which one: "tgpilot add ${dir}/${free[0]}". Available ${dir}/ types: ${free.join(', ')}.`);
    }
    fatal(`Say which one: "tgpilot add ${dir}/<name>".`);
  }

  const leaf = leafSegs.join('/');
  if (leaf.includes('/') && !nestableDirs().has(dir)) {
    fatal(`"${dir}/" holds single files only — use a plain name instead of "${leaf}".`);
  }

  const relPath = `${dir}/${leaf}.js`;
  if (!sanitizeRelPath(relPath)) fatal(`"${leaf}" is not a valid module name.`);

  const finalName = leaf.split('/').pop();
  if (descriptor?.allowedNames && !descriptor.allowedNames.includes(finalName)) {
    fatal(`"${finalName}" is not a valid ${dir}/ module name. Allowed: ${descriptor.allowedNames.join(', ')}.`);
  }

  if (existsDisk(relPath)) fatal(`${displayPath(relPath)} exists already.`);

  writeDisk(relPath, contentFor(dir, `${dir}/${leaf}`, finalName));

  log('info', 'add', 'Module scaffolded.', { module: `${dir}/${leaf}` });
  success(displayPath(relPath));
  info('Edit it, then "tgpilot push" to deploy.');
  return 0;
}

// The server's directory template when provided (with $$ tokens), else the
// bundled starter for that module kind.
function contentFor(dir, moduleName, name) {
  const raw = templates()[`${dir}/`];
  if (raw == null) return moduleStarter(dir, name);
  return raw.replace(MODULE_TOKEN, moduleName).replace(NAME_TOKEN, name);
}
