import { parseArgs } from '../args.js';
import { info, success, changed as changedLine } from '../output.js';
import { createBackup, listBackups, restoreBackup, removeBackup } from '../project/backup.js';
import { formatBytes } from '../project/static.js';
import { log } from '../logs.js';

// Backups are the safety net: a copy of the code as it works right now, so
// a change that breaks the bot can be undone with one command.
export async function registerBackup(argv) {
  const args = parseArgs(argv, { values: ['label'], flags: ['list', 'delete'] });
  const root = process.cwd();

  if (args.flags.list) return listBackupsCommand(root);
  if (args.flags.delete) {
    const id = args.positional[0];
    if (!id) {
      info('Which backup? "tgpilot backup --delete <id>"');
      return 1;
    }
    if (!removeBackup(root, id)) {
      info(`There is no backup called "${id}".`);
      return 1;
    }
    success(`Backup ${id} removed.`);
    return 0;
  }

  const manifest = createBackup(root, { label: args.values.label || '' });
  log('info', 'backup', 'Backup created.', { id: manifest.id, files: manifest.files });
  success(`Backup ${manifest.id} — ${manifest.files} files, ${formatBytes(manifest.bytes)}.`);
  info('Restore it with: tgpilot restore ' + manifest.id);
  return 0;
}

export async function registerBackups(argv) {
  return listBackupsCommand(process.cwd());
}

function listBackupsCommand(root) {
  const entries = listBackups(root);
  if (!entries.length) {
    info('No backups yet. Take one with "tgpilot backup".');
    return 0;
  }
  info(`\n  ${entries.length} backup${entries.length === 1 ? '' : 's'}:\n`);
  for (const entry of entries) {
    const when = new Date(entry.createdAt || 0).toLocaleString();
    const label = entry.label ? ` — ${entry.label}` : '';
    info(`  ${entry.id}${label}`);
    info(`    ${when} · ${entry.files} files · ${formatBytes(entry.bytes || 0)}`);
  }
  info('');
  info('  Restore one with: tgpilot restore <id>');
  return 0;
}

export async function registerRestore(argv) {
  const args = parseArgs(argv, { values: ['id'], flags: ['yes'] });
  const root = process.cwd();
  const id = args.values.id || args.positional[0];
  if (!id) {
    info('Which backup? "tgpilot restore <id>" — list them with "tgpilot backups".');
    return 1;
  }

  let result;
  try {
    result = restoreBackup(root, id);
  } catch (err) {
    info(err.message);
    return 1;
  }

  log('info', 'backup', 'Backup restored.', { id, files: result.restored.length });
  success(`Restored ${result.restored.length} files from ${id}.`);
  if (result.safety) {
    info(`The state before the restore was saved as ${result.safety.id}.`);
  }
  for (const file of result.restored.slice(0, 12)) changedLine(file);
  if (result.restored.length > 12) info(`  … and ${result.restored.length - 12} more`);
  info('');
  info('  Check it with "tgpilot diff", then deploy with "tgpilot push".');
  return 0;
}
