import { parseArgs } from '../args.js';
import { info, done, changed as changedLine, newFile as newLine, deleted as deletedLine, fatal, warn } from '../output.js';
import { c } from '../colors.js';
import { withToken } from '../project/credentials.js';
import { syncCapabilities } from '../project/layout.js';
import { warnStrayFiles } from '../project/scanner.js';
import { displayPath } from '../project/workdir.js';
import { planPush, settleRevision, sendDeploy, absorbResponse, isRevisionMismatch, describeStaticError } from '../project/deploy.js';
import { configFileName } from '../project/config.js';
import { formatBytes } from '../project/static.js';
import { serverErrorText } from '../api/client.js';
import { briefSummary } from '../project/changes.js';
import { createSpinner } from '../spinner.js';
import { confirm, closePrompts } from '../prompts.js';
import { log } from '../logs.js';

const SCHEMA_FILE = 'schema.js';

export async function registerPush(argv) {
  const args = parseArgs(argv, { flags: ['force'] });
  const force = args.flags.force === true;
  const targeted = args.positional.length > 0;

  await syncCapabilities();
  warnStrayFiles();

  let plan;
  try {
    plan = planPush({ targets: args.positional, force });
  } catch (err) {
    fatal(err.message);
  }

  console.log('\nChecking changes…');
  const { buckets } = plan;
  for (const p of buckets.modified) changedLine(displayPath(p));
  for (const p of buckets.added) newLine(displayPath(p));
  for (const p of buckets.deleted) deletedLine(displayPath(p));
  for (const entry of buckets.static) {
    if (entry.kind === 'remove') deletedLine(`Mini App files (${configFileName()}: "static": false)`);
    else if (entry.kind === 'config') changedLine(`static serving config (${configFileName()})`);
    else if (entry.kind === 'added') newLine(entry.path);
    else if (entry.kind === 'modified') changedLine(entry.path);
    else if (entry.kind === 'deleted') deletedLine(entry.path);
  }

  if (plan.changedCount === 0) {
    if (targeted) info(`Nothing to deploy for: ${args.positional.join(', ')}.`);
    else info('\nNothing to deploy.');
    return 0;
  }

  const startedAt = Date.now();
  let expected_revision;
  try {
    const settled = await withToken((token) => settleRevision(plan, { force, token }));
    expected_revision = settled.expected_revision;
  } catch (err) {
    fatal(err.kind === 'undeclared_bot' ? err.message : serverErrorText(err));
  }

  // Offline / non-interactive runs keep going with a printed warning instead
  // of a prompt, so scripts never hang.
  if (plan.deletedPaths.length && !force) {
    const n = plan.deletedPaths.length;
    console.log('');
    warn(`${n} module${n === 1 ? '' : 's'} deployed in the cloud are absent locally and will be deleted:`);
    for (const p of plan.deletedPaths) console.log('  ' + c.red(displayPath(p)));
    const interactive = process.stdout.isTTY === true || process.env.TGPILOT_ASSUME_TTY === '1' || process.env.TGCLOUD_ASSUME_TTY === '1';
    if (interactive && !targeted) {
      const ok = await confirm('Continue?');
      closePrompts();
      if (!ok) {
        log('info', 'push', 'Push cancelled at the deletion prompt.', { count: n });
        console.log('Cancelled.');
        return 0;
      }
    }
  }

  const deployingLine = `Deploying ${plan.changedCount} change${plan.changedCount === 1 ? '' : 's'}…`;

  let response;
  let uploaded = null;
  let staticSection;
  try {
    const sent = await withToken(async (token) => {
      const spinner = createSpinner(deployingLine);
      spinner.start();
      try {
        const out = await sendDeploy(plan, { expected_revision, token });
        spinner.stop();
        return out;
      } catch (err) {
        spinner.stop();
        throw err;
      }
    });
    response = sent.response;
    uploaded = sent.uploaded;
    staticSection = sent.staticSection;
  } catch (err) {
    if (isRevisionMismatch(err)) showRevisionMismatchHelp(err);
    else fatal(describeStaticError(err, plan.staticPlan));
    log('error', 'push', 'Deploy failed.', { error: err?.description || String(err) });
    return 1;
  }

  if (plan.codeChanged) {
    for (const p of plan.changedPaths) done(displayPath(p), p === SCHEMA_FILE ? 'schema' : undefined);
    for (const p of plan.deletedPaths) done(displayPath(p), 'deleted');
  }
  if (plan.staticChanged) {
    if (plan.staticPlan?.remove) {
      info('Mini App files removed.');
    } else if (uploaded?.count === 0) {
      const files = plan.staticPlan.diff.added.length + plan.staticPlan.diff.modified.length + plan.staticPlan.diff.deleted.length;
      done(`${plan.staticPlan.source}/`, files ? `${files} file${files === 1 ? '' : 's'} changed (already stored on the server)` : 'config updated');
    } else {
      done(`${plan.staticPlan.source}/`, `${uploaded.count} file${uploaded.count === 1 ? '' : 's'} uploaded (${formatBytes(uploaded.bytes)})`);
    }
  }

  absorbResponse(response, { staticSection });

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  info(`\nDone in ${elapsed}s`);
  if (plan.staticChanged && !plan.staticPlan?.remove && response?.static?.url) {
    info(`Mini App online at ${response.static.url}`);
  }

  log('info', 'push', 'Deploy finished.', {
    changed: plan.changedPaths.map(displayPath),
    deleted: plan.deletedPaths.map(displayPath),
    staticUploaded: uploaded?.count ?? 0,
    revision: response?.revision ?? null,
    durationMs: Date.now() - startedAt,
  });

  if (plan.schemaTouched && response?.db_changes?.length) {
    const n = response.db_changes.length;
    console.log('');
    console.log(c.bold(`Schema out of sync — ${n} database change${n === 1 ? '' : 's'} pending:`));
    console.log(briefSummary(response.db_changes));
    console.log('');
    info('Run "tgpilot migrate" to apply them.');
  }
  return 0;
}

export function showRevisionMismatchHelp(err) {
  const p = err?.parameters || {};
  console.error('');
  console.error(c.yellow('The cloud has moved on since the last sync.') + (p.current_revision != null ? c.dim(`  (cloud revision ${p.current_revision})`) : ''));
  console.error('Pick one:');
  console.error('  tgpilot fetch           keep the cloud state as the new baseline');
  console.error('  tgpilot pull            bring the cloud state into this folder');
  console.error('  tgpilot push --force    overwrite the cloud (careful)');
}
