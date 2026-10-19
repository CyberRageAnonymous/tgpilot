import { parseArgs } from '../args.js';
import { info, success, changed as changedLine } from '../output.js';
import { upgradeLayout } from '../project/upgrade.js';

export async function registerUpgrade(argv) {
  const args = parseArgs(argv, { flags: ['dry-run'] });
  const result = upgradeLayout({ dryRun: args.flags['dry-run'] === true });

  if (result.none) {
    info('This project already uses the current layout (everything under "tgcloud/"). Nothing to do.');
    return 0;
  }

  if (!result.moved.length) {
    info('Nothing to move.');
    return 0;
  }

  if (result.dryRun) {
    for (const move of result.moved) changedLine(move.to);
    info('\n(dry-run — nothing was moved)');
    return 0;
  }

  success(`Moved ${result.moved.length} file${result.moved.length === 1 ? '' : 's'} under tgcloud/.`);
  info('Run "tgpilot status" to compare with the cloud, then "tgpilot push".');
  return 0;
}
