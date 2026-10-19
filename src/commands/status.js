import { parseArgs } from '../args.js';
import { warn, info, fatal } from '../output.js';
import { c } from '../colors.js';
import { peekToken, maskToken, tokenEnvName } from '../project/credentials.js';
import { loadState } from '../project/state.js';
import { snapshotExists } from '../project/snapshot.js';
import { localDiff } from '../project/diff.js';
import { warnStrayFiles } from '../project/scanner.js';
import { displayPath } from '../project/workdir.js';
import { loadProjectConfig, configFileName } from '../project/config.js';
import { scanStatic, staticDiff, loadStaticSnapshot, unmanagedStaticNotice, formatBytes } from '../project/static.js';
import { webLine } from './webhook.js';

// Fully offline: it reads the last snapshot, never the network.

export async function registerStatus(argv) {
  parseArgs(argv, {});

  const envName = tokenEnvName();
  const envToken = envName ? process.env[envName] : null;
  const saved = peekToken();

  if (envToken) console.log(c.dim(`Linked through ${envName} (${maskToken(envToken)}).`));
  else if (saved) console.log(c.dim(`Linked to bot ${maskToken(saved)} (saved token).`));
  else console.log(c.dim('Not linked to a bot yet.'));

  const state = loadState();
  if (state.last_known_revision != null) {
    console.log(c.dim(`Last sync: revision ${state.last_known_revision}.`));
  }

  const line = await webLine();
  if (line) console.log(line);

  if (!snapshotExists()) {
    console.log('');
    warn('There is no local snapshot yet. Once linked, run "tgpilot fetch" or "tgpilot pull".');
  }

  const diff = localDiff();

  if (diff.modified.length) {
    console.log(`\n${c.bold('Modified:')} (${c.yellow('changed since last sync')})`);
    for (const f of diff.modified) console.log(`  ${c.yellow(displayPath(f.path))}`);
  }
  if (diff.newLocal.length) {
    console.log(`\n${c.bold('New, not deployed yet:')}`);
    for (const f of diff.newLocal) console.log(`  ${c.green(displayPath(f.path))}`);
  }
  if (diff.remoteOnly.length) {
    console.log(`\n${c.bold('Gone locally, still deployed:')}`);
    for (const f of diff.remoteOnly) console.log(`  ${c.red(displayPath(f.path))}`);
  }

  const dirty = diff.modified.length + diff.newLocal.length + diff.remoteOnly.length;
  if (dirty === 0 && diff.matched.length) {
    console.log(`\n${c.green('Everything matches the last deployed state.')}`);
  }

  warnStrayFiles();

  if (dirty === 0 && diff.matched.length === 0) {
    console.log('\nNo modules found here. "tgpilot init" scaffolds a project.');
  }

  printStatic();

  return 0;
}

// Mini App build status: local build output vs the last deployed static block.
function printStatic() {
  let block;
  try {
    block = loadProjectConfig().static;
  } catch (err) {
    warn(err.message);
    return;
  }
  const snapshot = loadStaticSnapshot();
  if (!block) {
    if (snapshot) {
      console.log('');
      for (const line of unmanagedStaticNotice(snapshot, configFileName())) console.log('  ' + line);
    }
    return;
  }
  if (block.remove) {
    if (snapshot) console.log(`\n${c.red(`Static site will be removed on the next push (${configFileName()}): "static": false.`)}`);
    return;
  }

  console.log(`\n${c.bold(`Mini App build (${block.source}/)`)}`);
  const scan = scanStatic(block.source);
  if (!scan) {
    warn(`Folder "${block.source}/" is missing — run the build first.`);
    return;
  }
  if (Object.keys(scan.manifest).length === 0) {
    warn(`Folder "${block.source}/" is empty — run the build first.`);
    return;
  }

  const d = staticDiff(scan, block.config, snapshot);
  const line = (p) => `  ${block.source}/${p}`;
  if (d.modified.length) {
    console.log(`${c.yellow('Modified:')}`);
    d.modified.forEach((p) => console.log(line(p)));
  }
  if (d.added.length) {
    console.log(snapshot ? `${c.green('New, not deployed yet:')}` : `${c.green('Not deployed yet:')}`);
    d.added.forEach((p) => console.log(line(p)));
  }
  if (d.deleted.length) {
    console.log(`${c.red('Gone locally, still deployed:')}`);
    d.deleted.forEach((p) => console.log(line(p)));
  }
  if (d.configChanged && snapshot) console.log(`${c.yellow('Modified:')} static serving config (${configFileName()})`);
  if (!d.changed) {
    console.log(c.green(`Up to date (${d.unchanged} file${d.unchanged === 1 ? '' : 's'} deployed).`));
    if (snapshot?.url) console.log(`Serving: ${snapshot.url}`);
  }
  if (scan.nonNfc.length) {
    warn(`${scan.nonNfc.length} path${scan.nonNfc.length === 1 ? ' is' : 's are'} not NFC-normalized (e.g. ${scan.nonNfc[0]}). Prefer ASCII file names — URLs match byte-exact.`);
  }
}
