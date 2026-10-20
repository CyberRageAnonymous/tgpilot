import { readPackageVersion } from './meta.js';
import { requireCurrentLayout } from './project/root.js';

// The CLI itself: `tgpilot [command] [...flags]`. Every command is a small
// module that takes parsed args and does its work; this file wires them up.

// Commands that work on the module space refuse to run on the pre-tgcloud
// layout; init/login/upgrade/web are exempt (web routes a project only once
// it exists, and those must be able to create or move it).
const MODULE_COMMANDS = new Set([
  'add', 'status', 'diff', 'push', 'pull', 'fetch', 'reset', 'run', 'migrate', 'webhook', 'logs',
]);

const USAGE = `tgpilot — write, run and deploy Telegram Serverless bots from the terminal

Commands:
  init            scaffold a new project in the current folder
  add <target>    scaffold one module (handlers/, endpoints/ or lib/)
  login           link this folder to a bot
  logout          forget the saved token
  status          compare the folder with the last known cloud state
  diff [files..]  line-by-line changes for that comparison
  push [files..]  deploy changed modules (and the Mini App build) to the bot
  pull            bring the cloud state into this folder
  fetch           refresh the local snapshot only
  reset [file]    throw local changes away, restore from the snapshot
  run <module>    run a handler in the cloud without deploying it
  migrate         apply pending schema changes to the database
  webhook         show the bot webhook state (webhook sync to repair)
  logs [-n N]     read this tool's journal
  profiles        the bots this folder is linked to (--use <name> to switch)
  ping [--probe]  check how this machine reaches the cloud (proxy, DNS, route)
  backup [--label L]  save a copy of the project you can roll back to
  backups         list the saved copies
  restore <id>    put a saved copy back (the current state is saved first)
  web             open the studio in a browser
  upgrade         move an old project layout under tgcloud/

Global:
  --version       print the version
  --help          print this help
  TGPILOT_TOKEN   an access token override (for scripts)`;

export async function main(argv) {
  const [first, ...rest] = argv;

  if (!first || first === 'help' || first === '--help' || first === '-h') {
    console.log(USAGE);
    return 0;
  }
  if (first === '--version' || first === '-v' || first === 'version') {
    console.log(readPackageVersion());
    return 0;
  }

  if (MODULE_COMMANDS.has(first)) requireCurrentLayout();

  switch (first) {
    case 'init': {
      const { registerInit } = await import('./commands/init.js');
      return registerInit(rest);
    }
    case 'add': {
      const { registerAdd } = await import('./commands/add.js');
      return registerAdd(rest);
    }
    case 'login':
    case 'logout': {
      const { registerAuth } = await import('./commands/auth.js');
      return registerAuth(first, rest);
    }
    case 'profiles': {
      const { registerProfiles } = await import('./commands/auth.js');
      return registerProfiles(rest);
    }
    case 'status': {
      const { registerStatus } = await import('./commands/status.js');
      return registerStatus(rest);
    }
    case 'diff': {
      const { registerDiff } = await import('./commands/diff.js');
      return registerDiff(rest);
    }
    case 'push': {
      const { registerPush } = await import('./commands/push.js');
      return registerPush(rest);
    }
    case 'pull': {
      const { registerPull } = await import('./commands/pull.js');
      return registerPull(rest);
    }
    case 'fetch': {
      const { registerFetch } = await import('./commands/fetch.js');
      return registerFetch(rest);
    }
    case 'reset': {
      const { registerReset } = await import('./commands/reset.js');
      return registerReset(rest);
    }
    case 'run': {
      const { registerRun } = await import('./commands/run.js');
      return registerRun(rest);
    }
    case 'migrate': {
      const { registerMigrate } = await import('./commands/migrate.js');
      return registerMigrate(rest);
    }
    case 'webhook': {
      const { registerWebhook } = await import('./commands/webhook.js');
      return registerWebhook(rest);
    }
    case 'logs': {
      const { registerLogs } = await import('./commands/logs.js');
      return registerLogs(rest);
    }
    case 'web': {
      const { registerWeb } = await import('./commands/web.js');
      return registerWeb(rest);
    }
    case 'upgrade': {
      const { registerUpgrade } = await import('./commands/upgrade.js');
      return registerUpgrade(rest);
    }
    case 'backup': {
      const { registerBackup } = await import('./commands/backup.js');
      return registerBackup(rest);
    }
    case 'backups': {
      const { registerBackups } = await import('./commands/backup.js');
      return registerBackups(rest);
    }
    case 'restore': {
      const { registerRestore } = await import('./commands/backup.js');
      return registerRestore(rest);
    }
    case 'ping': {
      const { registerPing } = await import('./commands/ping.js');
      return registerPing(rest);
    }
    default: {
      console.error(`"${first}" is not a tgpilot command. Run "tgpilot help" to see the list.`);
      return 1;
    }
  }
}
