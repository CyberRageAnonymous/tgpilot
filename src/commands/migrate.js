import { parseArgs } from '../args.js';
import { fail, fatal } from '../output.js';
import { c } from '../colors.js';
import { withToken } from '../project/credentials.js';
import { syncCapabilities } from '../project/layout.js';
import { getMigrationStatus, applyMigration } from '../api/endpoints.js';
import { serverErrorText } from '../api/client.js';
import { changeCard, briefSummary, changeId, kindLabel, headerTarget } from '../project/changes.js';
import { readSnapshotFile } from '../project/snapshot.js';
import { existsDisk, readDisk, displayPath } from '../project/workdir.js';
import { createSpinner } from '../spinner.js';
import { confirm, askLetter, waitForEnter, closePrompts, EOF } from '../prompts.js';
import { log } from '../logs.js';

const SCHEMA_FILE = 'schema.js';
const SCHEMA_SHOWN = displayPath(SCHEMA_FILE);

export async function registerMigrate(argv) {
  const args = parseArgs(argv, {
    flags: ['yes', 'safe', 'local', 'dry-run'],
  });
  const options = { yes: args.flags.yes === true, safe: args.flags.safe === true, dryRun: args.flags['dry-run'] === true };

  if (options.yes && options.safe) fatal('--yes and --safe are mutually exclusive.');
  if (options.dryRun && (options.yes || options.safe)) fatal('--dry-run cannot be combined with --yes/--safe (nothing gets applied in dry-run).');

  const tty = process.stdout.isTTY || process.env.TGPILOT_ASSUME_TTY === '1' || process.env.TGCLOUD_ASSUME_TTY === '1';
  if (!tty && !options.dryRun && !options.safe && !options.yes) {
    fatal('This is a non-interactive session — pass --safe, --yes, or --dry-run.');
  }

  await syncCapabilities();

  let localSchema = null;
  if (args.flags.local === true) {
    if (!existsDisk(SCHEMA_FILE)) fatal(`--local needs a local ${SCHEMA_SHOWN}, but there is none here.`);
    localSchema = readDisk(SCHEMA_FILE);
  }

  try {
    await withToken(async (token) => {
      const spinner = createSpinner('Checking schema…');
      spinner.start();
      let status;
      try {
        status = localSchema != null
          ? await applyMigration(token, { schema: localSchema, dry_run: true })
          : await getMigrationStatus(token);
        spinner.stop();
      } catch (err) {
        spinner.stop();
        throw err;
      }

      const dbChanges = status?.db_changes || [];

      if (args.flags.local === true) {
        console.log(c.dim(`(diff computed against your local ${SCHEMA_SHOWN})`));
      }

      if (!dbChanges.length) {
        console.log(`No schema changes. The database is in sync with ${args.flags.local ? `your local ${SCHEMA_SHOWN}` : `the deployed ${SCHEMA_SHOWN}`}.`);
        if (args.flags.local !== true) {
          const divergence = localSchemaDivergence();
          if (divergence) printSchemaDivergenceWarning(divergence);
        }
        return;
      }

      if (args.flags.local !== true) {
        const divergence = localSchemaDivergence();
        if (divergence) printSchemaDivergenceWarning(divergence);
      }

      const result = await migrationFlow(token, dbChanges, options);
      const failed = result?.failed || 0;
      log('info', 'migrate', 'Migration finished.', { ...result });
      if (failed > 0) process.exitCode = 1;
    });
  } catch (err) {
    fail(serverErrorText(err));
    log('error', 'migrate', 'Migration failed.', { error: err?.description || String(err) });
    process.exit(1);
  } finally {
    closePrompts();
  }
  return 0;
}

// Non-null when the local schema file differs from the last deployed one.
function localSchemaDivergence() {
  const localExists = existsDisk(SCHEMA_FILE);
  const remoteContent = readSnapshotFile(SCHEMA_FILE);

  if (!localExists && remoteContent == null) return null;
  if (!localExists && remoteContent != null) return 'deleted_locally';
  if (localExists && remoteContent == null) return 'new_locally';
  return readDisk(SCHEMA_FILE) === remoteContent ? null : 'modified_locally';
}

function printSchemaDivergenceWarning(kind) {
  console.log(`\n${c.yellow('Warning: ')}your local ${SCHEMA_SHOWN} differs from what is deployed.`);
  console.log(
    '  The pending changes below are the diff between the DEPLOYED schema and the\n' +
    '  database — they do NOT include your local edits. Run "tgpilot push" first if\n' +
    '  those edits should be part of this migration, or pass --local to diff\n' +
    '  against your local file instead.'
  );
  if (kind === 'new_locally') console.log(`  (Note: ${SCHEMA_SHOWN} is new locally — never deployed.)`);
  else if (kind === 'deleted_locally') console.log(`  (Note: ${SCHEMA_SHOWN} was deleted locally but still exists in the cloud.)`);
  console.log('');
}

// Safe changes go in one request; each warning in its own, so earlier ones
// stay applied when a later one fails. Manual and undocumented are shown only.
async function migrationFlow(token, dbChanges, options) {
  const good = dbChanges.filter((change) => change.status === 'good');
  const warning = dbChanges.filter((change) => change.status === 'warning');
  const manual = dbChanges.filter((change) => change.status === 'manual');
  const undoc = dbChanges.filter((change) => change.status === 'undocumented');

  const count = dbChanges.length;
  console.log('');
  console.log(c.bold(`Schema out of sync — ${count} change${count === 1 ? '' : 's'}:`));
  console.log(briefSummary(dbChanges));
  console.log('');

  if (options.dryRun) {
    for (const change of dbChanges) {
      console.log(changeCard(change));
      console.log('');
    }
    console.log(c.dim('(dry-run — nothing was applied)'));
    return undefined;
  }

  const stats = { applied: 0, skipped: 0, failed: 0 };

  if (options.yes || options.safe) {
    if (good.length) {
      for (const change of good) {
        console.log(changeCard(change));
        console.log('');
      }
      const ok = await applyBatch(token, good);
      if (ok) stats.applied += good.length;
      else stats.failed += good.length;
      console.log('');
    }
    for (const change of warning) {
      console.log(changeCard(change));
      console.log('');
      if (options.yes) {
        const ok = await applySingle(token, change);
        if (ok) stats.applied++;
        else stats.failed++;
      } else {
        console.log(c.dim('  ⊘ skipped (--safe)'));
        stats.skipped++;
      }
      console.log('');
    }
    for (const change of manual) {
      console.log(changeCard(change));
      console.log('');
      console.log(c.blue('Note: ') + 'this change must be applied to the database manually.');
      console.log('');
    }
    for (const change of undoc) {
      console.log(changeCard(change));
      console.log('');
      console.log(c.blue('Note: ') + `not in the schema. Update ${SCHEMA_SHOWN}, or mark it deprecated to remove.`);
      console.log('');
    }
    printSummary(stats, { manual: manual.length, undoc: undoc.length, quit: false });
    return stats;
  }

  const proceed = await confirm('Proceed with the migration?');
  if (!proceed) {
    console.log('\nCancelled.');
    closePrompts();
    return { applied: 0, skipped: 0, failed: 0 };
  }

  const state = {
    idx: 0,
    total:
      (good.length > 0 ? 1 : 0) +
      warning.length +
      (manual.length > 0 ? 1 : 0) +
      (undoc.length > 0 ? 1 : 0),
    quit: false,
  };

  if (good.length === 1) {
    await stepSingle(token, good[0], state, stats);
  } else if (good.length > 1) {
    await stepSafeGroup(token, good, state, stats);
  }

  if (!state.quit) {
    for (let i = 0; i < warning.length; i++) {
      await stepSingle(token, warning[i], state, stats);
      if (state.quit) {
        stats.skipped += warning.length - i - 1;
        break;
      }
    }
  } else {
    stats.skipped += warning.length;
  }

  if (!state.quit) {
    if (manual.length) await stepInfoGroup(manual, 'manual', state);
    if (undoc.length) await stepInfoGroup(undoc, 'undocumented', state);
  }

  closePrompts();

  printSummary(stats, { manual: manual.length, undoc: undoc.length, quit: state.quit });
  return stats;
}

async function stepSingle(token, change, state, stats) {
  state.idx++;
  console.log(changeCard(change));
  console.log('');

  const choice = await askLetter(`[${state.idx}/${state.total}] Apply?`, [
    { key: 'y', label: 'yes' },
    { key: 'n', label: 'no' },
    { key: 'q', label: 'quit' },
  ]);

  if (choice === 'q' || choice === EOF) {
    state.quit = true;
    stats.skipped++;
    console.log(c.dim('  ⊘ skipped (quit)'));
    return;
  }
  if (choice === 'n') {
    stats.skipped++;
    console.log(c.dim('  ⊘ skipped'));
    return;
  }
  const ok = await applySingle(token, change);
  if (ok) stats.applied++;
  else stats.failed++;
}

async function stepSafeGroup(token, group, state, stats) {
  state.idx++;
  for (const change of group) {
    console.log(changeCard(change));
    console.log('');
  }

  const choice = await askLetter(
    `[${state.idx}/${state.total}] Apply these ${group.length} changes?`,
    [
      { key: 'y', label: 'yes' },
      { key: 'n', label: 'no' },
      { key: 'q', label: 'quit' },
    ]
  );

  if (choice === 'q' || choice === EOF) {
    state.quit = true;
    stats.skipped += group.length;
    console.log(c.dim(`  ⊘ skipped ${group.length} (quit)`));
    return;
  }
  if (choice === 'n') {
    stats.skipped += group.length;
    console.log(c.dim(`  ⊘ skipped ${group.length}`));
    return;
  }
  const ok = await applyBatch(token, group);
  if (ok) stats.applied += group.length;
  else stats.failed += group.length;
}

// Manual and undocumented changes show up as one step; nothing gets applied.
async function stepInfoGroup(changes, kind, state) {
  state.idx++;
  for (const change of changes) {
    console.log(changeCard(change));
    console.log('');
  }

  const n = changes.length;
  const body = kind === 'manual'
    ? (n === 1
        ? 'This change must be applied to the database manually.'
        : `These ${n} changes must be applied to the database manually.`)
    : (n === 1
        ? `Not in the schema. Update ${SCHEMA_SHOWN}, or mark it deprecated to remove.`
        : `${n} elements exist in the database but not in the schema.\n  Update ${SCHEMA_SHOWN} to match, or mark them as deprecated to remove.`);
  console.log(c.blue('Note: ') + body);
  console.log('');

  await waitForEnter(`[${state.idx}/${state.total}] Press Enter…`);
}

function printSummary(stats, { manual, undoc, quit }) {
  console.log('');

  const parts = [`applied: ${stats.applied}`, `skipped: ${stats.skipped}`];
  if (stats.failed) parts.push(`failed: ${stats.failed}`);
  if (manual) parts.push(`awaiting manual fix: ${manual}`);
  if (undoc) parts.push(`not in schema: ${undoc}`);

  const nothingActed = stats.applied === 0 && stats.skipped === 0 && stats.failed === 0;
  const prefix = quit ? 'Migration interrupted.' : nothingActed ? 'Migration finished.' : 'Migration complete.';
  console.log(c.bold(`${prefix} ${parts.join(', ')}.`));
}

async function applyBatch(token, changes) {
  const ids = changes.map(changeId);
  const spinner = createSpinner(`Applying ${ids.length} change${ids.length === 1 ? '' : 's'}…`);
  spinner.start();
  try {
    await applyMigration(token, { apply: ids });
    spinner.stop();
    for (const change of changes) console.log(c.green(`  ✓ ${headerTarget(change)}`));
    return true;
  } catch (err) {
    spinner.stop();
    fail(`Batch failed: ${plainText(err)}`);
    log('error', 'migrate', 'Batch apply failed.', { ids });
    return false;
  }
}

async function applySingle(token, change) {
  const id = changeId(change);
  const target = headerTarget(change);
  const label = kindLabel(change);
  const spinner = createSpinner(`Applying ${label} "${target}"…`);
  spinner.start();
  try {
    await applyMigration(token, { apply: [id] });
    spinner.stop();
    console.log(c.green(`  ✓ ${target}`));
    log('info', 'migrate', 'Change applied.', { id });
    return true;
  } catch (err) {
    spinner.stop();
    fail(`${label} "${target}": ${plainText(err)}`);
    log('error', 'migrate', 'Apply failed.', { id, error: err?.description || String(err) });
    return false;
  }
}

function plainText(err) {
  return err?.description || err?.message || String(err);
}
