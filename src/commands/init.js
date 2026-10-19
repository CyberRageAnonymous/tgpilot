import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { parseArgs } from '../args.js';
import { info, success, fatal } from '../output.js';
import { loadState, saveInitTemplateHash } from '../project/state.js';
import { findProjectRoot } from '../project/root.js';
import { requireCurrentLayout } from '../project/root.js';
import { resetLayout, syncCapabilities, scaffoldEntries, templates, unplaceModulePath, MODULE_ROOT } from '../project/layout.js';
import { loadProjectConfig, CONFIG_FILE_JSONC, configFileName } from '../project/config.js';
import { detectFrontend, readPackageJson } from '../project/frontend.js';
import { toPosix } from '../project/snapshot.js';
import { SCHEMA_STARTER, handlerStarter } from '../templates.js';
import { log } from '../logs.js';

const GITIGNORE = '.tgpilot/\n.tgcloud/\nnode_modules/\n';

// Starter content for a scaffolded file: the server's template when it offers
// one, else the bundled copy. `null` means nothing to write at all.
function templateContent(entry, serverTemplates) {
  const key = unplaceModulePath(entry);
  if (serverTemplates[key] != null) return serverTemplates[key];
  if (key === 'schema.js' || key === `${MODULE_ROOT}/schema.js`) return SCHEMA_STARTER;
  if (key === 'handlers/message.js' || key === `${MODULE_ROOT}/handlers/message.js`) return handlerStarter('message');
  return null;
}

function sha256Hex(buffer) {
  return 'sha256:' + createHash('sha256').update(buffer).digest('hex');
}

// Starter tgcloud.jsonc. With a Vite-style build detected, the static block is
// written live; otherwise it stays as a comment for when a Mini App is added.
function ensureProjectConfig(frontend) {
  if (fs.existsSync('tgcloud.json') || fs.existsSync(CONFIG_FILE_JSONC)) return false;
  const lines = [];
  lines.push('{');
  if (frontend?.source) {
    lines.push('  "static": {', `    "source": ${JSON.stringify(frontend.source)}`, '  }');
  } else {
    lines.push(
      '  // Host a Mini App build: uncomment and point "source" at the output folder.',
      '  // "static": {',
      '  //   "source": "dist",',
      '  //   "spa": true',
      '  // }',
      '  //',
      '  // Deploying never runs a build for you: use "npm run deploy" after building.'
    );
  }
  lines.push('}');
  fs.writeFileSync(CONFIG_FILE_JSONC, lines.join('\n') + '\n');
  return true;
}

// npm scripts pointing at this tool; existing keys are never overwritten.
function ensurePackageJson(staticManaged, hadBuildScript) {
  let created = false;
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync('package.json', 'utf-8'));
    if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) return null;
  } catch {
    pkg = {
      name: (path.basename(process.cwd()).toLowerCase().replace(/[^a-z0-9_-]+/g, '-') || 'tgcloud-project'),
      private: true,
    };
    created = true;
  }

  const deploy = staticManaged && hadBuildScript ? 'npm run build && tgpilot push' : 'tgpilot push';
  const wanted = { deploy, status: 'tgpilot status', run: 'tgpilot run' };
  let touched = false;
  if (!pkg.scripts || typeof pkg.scripts !== 'object') {
    pkg.scripts = {};
    touched = Object.keys(wanted).length > 0;
  }
  for (const [name, value] of Object.entries(wanted)) {
    if (!(name in pkg.scripts)) { pkg.scripts[name] = value; touched = true; }
  }
  if (created || touched) {
    fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
    return created ? 'created' : 'updated';
  }
  return null;
}

function mergeGitignore() {
  if (fs.existsSync('.gitignore')) {
    const norm = (line) => line.trim().replace(/^\/+|\/+$/g, '');
    const existing = fs.readFileSync('.gitignore', 'utf-8');
    const have = new Set(existing.split('\n').map(norm));
    const additions = GITIGNORE.split('\n').filter((l) => l && !have.has(norm(l)));
    if (additions.length === 0) return false;
    const suffix = existing.endsWith('\n') || existing === '' ? '' : '\n';
    fs.appendFileSync('.gitignore', suffix + additions.join('\n') + '\n');
    return true;
  }
  fs.writeFileSync('.gitignore', GITIGNORE);
  return true;
}

async function setupGit() {
  const { execSync } = await import('node:child_process');
  try {
    execSync('git rev-parse --is-inside-work-tree', { stdio: 'ignore' });
    info('Inside an existing git repository; left as is.');
    return;
  } catch { /* no work tree yet */ }

  try {
    execSync('git init', { stdio: 'ignore' });
  } catch {
    return; // git missing entirely
  }
  try {
    execSync('git add -A', { stdio: 'ignore' });
    execSync('git commit -m "Initial commit"', { stdio: 'ignore' });
    info('Created a git repository with an initial commit.');
  } catch {
    fs.rmSync('.git', { recursive: true, force: true });
    info('Git skipped. Set user.name and user.email first, then run "git init".');
  }
}

export async function registerInit(argv) {
  const args = parseArgs(argv, { flags: ['no-git'] });

  const root = findProjectRoot();
  if (root && path.resolve(root) !== path.resolve(process.cwd())) {
    fatal(`A tgcloud project already starts at ${root}.\n  Work on that project, or scaffold somewhere else.`);
  }
  if (root) requireCurrentLayout();

  await syncCapabilities();
  resetLayout();

  const serverTemplates = templates();
  const createdDirs = [];
  const createdFiles = [];
  const scaffoldedJs = [];

  for (const entry of scaffoldEntries()) {
    if (entry.endsWith('/')) {
      const dir = entry.slice(0, -1);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        createdDirs.push(dir);
      }
      continue;
    }
    if (fs.existsSync(entry)) continue;
    const content = templateContent(entry, serverTemplates);
    if (content == null) continue;
    const parent = path.dirname(entry);
    if (parent !== '.') fs.mkdirSync(parent, { recursive: true });
    fs.writeFileSync(entry, content);
    createdFiles.push(entry);
    // Scaffold entries already live in the module root, so this IS the
    // init_templates key form ("tgcloud/handlers/message.js").
    if (entry.endsWith('.js')) scaffoldedJs.push(toPosix(entry));
  }

  if (mergeGitignore()) createdFiles.push('.gitignore');

  const frontend = detectFrontend(readPackageJson());
  if (ensureProjectConfig(frontend)) {
    createdFiles.push(CONFIG_FILE_JSONC);
  }

  let staticManaged = false;
  try {
    staticManaged = Boolean(loadProjectConfig({ tolerant: true }).static);
  } catch { /* a broken config stays broken; push will complain properly */ }
  const pkgState = ensurePackageJson(staticManaged, Boolean(readPackageJson()?.scripts?.build));
  if (pkgState) createdFiles.push('package.json');

  // Starter files are fingerprinted so a later pull knows which of them are
  // still untouched scaffolding and can be replaced safely.
  for (const moduleFile of scaffoldedJs) {
    saveInitTemplateHash(moduleFile, sha256Hex(fs.readFileSync(moduleFile)));
  }

  console.log('');
  info('Scaffolded:');
  const emptyDirs = createdDirs.filter((d) => !createdFiles.some((f) => f === d || f.startsWith(`${d}/`))).map((d) => `${d}/`);
  for (const line of [...createdFiles, ...emptyDirs].sort()) success(line);

  if (!args.flags['no-git']) {
    await setupGit();
  }

  log('info', 'init', 'Project scaffolded.', { files: createdFiles, dirs: createdDirs });

  console.log('');
  info('Project ready. The starters are a first cut — edit or delete them freely.');
  if (frontend?.name && staticManaged) {
    info(`Found a ${frontend.name} front-end; its build is deployed along with the bot.`);
  } else if (frontend?.name && !frontend.source) {
    info(`Found a ${frontend.name} front-end. Configure a static export, then point "static" at its output folder (${configFileName()}).`);
  }
  console.log('');
  info('Next steps:');
  info('  tgpilot login    link this folder to a bot');
  info('  tgpilot push     deploy to the cloud');
  info('  tgpilot web      open the studio');
  return 0;
}
