import { fail, fatal, success } from '../output.js';
import { c } from '../colors.js';
import { withToken } from '../project/credentials.js';
import { callBotApi, readBotProfile } from '../api/botapi.js';
import { serverErrorText } from '../api/client.js';
import { createSpinner } from '../spinner.js';
import { log } from '../logs.js';

// The bot's own profile: its name, what it says about itself, and the button
// beside the message field. All of it is edited through Telegram's Bot API,
// run inside the platform, so the token stays where it already is.

const USAGE = `Usage:
  tgpilot bot                          show the profile and the menu button
  tgpilot bot name <text>              set the bot's name
  tgpilot bot description <text>       set the long description (the "About")
  tgpilot bot short <text>             set the short description
  tgpilot bot menu <url> [text]        menu button that opens a Mini App
  tgpilot bot menu commands [text]     menu button that opens the command list
  tgpilot bot menu off                 give the button back to Telegram`;

function row(label, value) {
  console.log('  ' + `${label}:`.padEnd(20) + value);
}

function blank(text) {
  return text && text.trim() ? text.trim() : c.dim('(empty)');
}

// One status line for the whole command: a pipeline sees what it waits on,
// a terminal gets the animation, and neither is told about it five times.
async function talking(text, fn) {
  const spinner = createSpinner(text);
  spinner.start();
  try {
    return await fn();
  } finally {
    spinner.stop();
  }
}

// Text that reaches Telegram has to be there: an empty profile field would
// be a silent no-op the user only discovers by opening the bot.
function requireText(rest, what, example) {
  const text = rest.join(' ').trim();
  if (!text) fatal(`${what} cannot be empty — e.g. tgpilot bot ${example}`);
  return text;
}

function reportError(err, method) {
  fail(serverErrorText(err));
  log('error', 'bot', 'Bot API call failed.', { method, error: err?.description || String(err) });
  process.exitCode = 1;
}

async function showProfile(token) {
  const profile = await talking('Reading the profile…', () => readBotProfile(token));
  const { menu } = profile;

  console.log('');
  row('bot', `@${profile.username || c.dim('(no username)')}`);
  row('id', String(profile.id));
  row('name', blank(profile.name));
  row('description', blank(profile.description));
  row('short description', blank(profile.short));

  console.log('');
  console.log(c.dim('Menu button:'));
  if (menu.type === 'web_app') {
    row('opens', menu.text || c.dim('(no text)'));
    row('mini app', menu.web_app?.url || c.dim('(no url)'));
  } else if (menu.type === 'commands') {
    row('shows', 'the command list');
  } else {
    row('shows', "Telegram's default");
  }

  log('info', 'bot', 'Profile read.', { username: profile.username });
  return 0;
}

async function setText(token, method, field, text, label) {
  const result = await talking('Talking to Telegram…', () => callBotApi(token, method, { [field]: text }));
  // A setter answers `true` or echoes the stored value; either way it is done.
  const stored = typeof result === 'object' && result ? (result[field] ?? text) : text;
  success(`${label} updated.`);
  console.log(`  ${c.dim(String(stored))}`);
  log('info', 'bot', 'Profile updated.', { field, length: text.length });
  return 0;
}

async function setMenu(token, rest) {
  const [first, ...tail] = rest;
  if (!first) fatal(USAGE);

  if (first === 'off') {
    await talking('Talking to Telegram…', () => callBotApi(token, 'setChatMenuButton', { menu_button: { type: 'default' } }));
    success("Menu button handed back to Telegram's default.");
    log('info', 'bot', 'Menu button reset.', { type: 'default' });
    return 0;
  }

  if (first === 'commands') {
    const text = tail.join(' ').trim() || 'Commands';
    await talking('Talking to Telegram…', () =>
      callBotApi(token, 'setChatMenuButton', { menu_button: { type: 'commands', text } })
    );
    success('Menu button now opens the command list.');
    log('info', 'bot', 'Menu button set.', { type: 'commands' });
    return 0;
  }

  const url = first;
  if (!/^https:\/\//i.test(url)) {
    fatal('A Mini App address has to be https — e.g. tgpilot bot menu https://example.com/app Open');
  }
  const text = tail.join(' ').trim() || 'Open';
  await talking('Talking to Telegram…', () =>
    callBotApi(token, 'setChatMenuButton', {
      menu_button: { type: 'web_app', text, web_app: { url } },
    })
  );
  success(`Menu button now opens ${url}`);
  console.log(`  ${c.dim(text)}`);
  log('info', 'bot', 'Menu button set.', { type: 'web_app' });
  return 0;
}

export async function registerBot(argv) {
  const [action, ...rest] = argv;
  if (action === '--help' || action === '-h' || action === 'help') {
    console.log(USAGE);
    return 0;
  }

  await withToken(async (token) => {
    try {
      if (!action) {
        process.exitCode = await showProfile(token);
        return;
      }
      if (action === 'name') {
        const text = requireText(rest, 'The name', 'name "My Bot"');
        process.exitCode = await setText(token, 'setMyName', 'name', text, 'Name');
        return;
      }
      if (action === 'description') {
        const text = requireText(rest, 'The description', 'description "What I do"');
        process.exitCode = await setText(token, 'setMyDescription', 'description', text, 'Description');
        return;
      }
      if (action === 'short') {
        const text = requireText(rest, 'The short description', 'short "One line about me"');
        process.exitCode = await setText(token, 'setMyShortDescription', 'short_description', text, 'Short description');
        return;
      }
      if (action === 'menu') {
        process.exitCode = await setMenu(token, rest);
        return;
      }
      fatal(`Unknown action "${action}".\n\n${USAGE}`);
    } catch (err) {
      reportError(err, action || 'getMe');
    }
  });

  return process.exitCode || 0;
}
