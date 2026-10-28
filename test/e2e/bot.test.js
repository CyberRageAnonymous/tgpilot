import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startMockCloud, stopMockCloud, Project } from './helpers/helpers.js';

let cloud;

test.before(async () => {
  cloud = await startMockCloud();
  // The last test imports the client in this process, where the spawned CLI
  // would normally carry the address.
  process.env.TGPILOT_API_URL = cloud.baseUrl;
});

test.after(async () => {
  if (cloud) await stopMockCloud(cloud);
});

// Every case gets its own bot: the profile of one test must never be what
// another test reads back.

function newProject(name) {
  return new Project(cloud, cloud.mintToken(), name);
}

test('the bot profile can be read', async () => {
  const proj = newProject('bot-read');
  await proj.cli(['init']);

  const out = await proj.cli(['bot']);
  assert.equal(out.code, 0, out.out);
  assert.match(out.out, /bot:\s+@mock_app\d+/);
  assert.match(out.out, /name:\s+Mock Bot/);
  assert.match(out.out, /description:\s+\(empty\)/);
  assert.match(out.out, /Menu button:/);
  assert.match(out.out, /Telegram's default/);
  assert.equal(out.out.match(/Reading the profile/g)?.length ?? 0, 1, 'one status line, not five');
});

test('name, description and short description can be edited', async () => {
  const proj = newProject('bot-edit');
  await proj.cli(['init']);

  const name = await proj.cli(['bot', 'name', 'Weather', 'Fox']);
  assert.equal(name.code, 0, name.out);
  assert.match(name.out, /Name updated/);
  assert.match(name.out, /Weather Fox/);

  const desc = await proj.cli(['bot', 'description', 'I', 'tell', 'you', 'the', 'weather.']);
  assert.equal(desc.code, 0, desc.out);
  assert.match(desc.out, /Description updated/);

  const short = await proj.cli(['bot', 'short', 'Weather, hourly.']);
  assert.equal(short.code, 0, short.out);
  assert.match(short.out, /Short description updated/);

  // Read back: what Telegram holds is what the CLI shows.
  const out = await proj.cli(['bot']);
  assert.match(out.out, /name:\s+Weather Fox/);
  assert.match(out.out, /description:\s+I tell you the weather\./);
  assert.match(out.out, /short description:\s+Weather, hourly\./);

  // And the calls really reached the platform.
  const appId = proj.token.split(':')[0];
  const bot = cloud.bots.get(appId);
  const methods = bot.botApiCalls.map((c) => c.method);
  assert.ok(methods.includes('setMyName'), `setMyName was called: ${methods.join(', ')}`);
  assert.ok(methods.includes('setMyDescription'), 'setMyDescription was called');
  assert.ok(methods.includes('setMyShortDescription'), 'setMyShortDescription was called');
});

test('the menu button can open a Mini App, show commands, and be reset', async () => {
  const proj = newProject('bot-menu');
  await proj.cli(['init']);

  const app = await proj.cli(['bot', 'menu', 'https://example.com/app', 'Open', 'me']);
  assert.equal(app.code, 0, app.out);
  assert.match(app.out, /Menu button now opens https:\/\/example.com\/app/);

  let out = await proj.cli(['bot']);
  assert.match(out.out, /opens:\s+Open me/);
  assert.match(out.out, /mini app:\s+https:\/\/example.com\/app/);

  const commands = await proj.cli(['bot', 'menu', 'commands']);
  assert.equal(commands.code, 0, commands.out);
  out = await proj.cli(['bot']);
  assert.match(out.out, /shows:\s+the command list/);

  const off = await proj.cli(['bot', 'menu', 'off']);
  assert.equal(off.code, 0, off.out);
  out = await proj.cli(['bot']);
  assert.match(out.out, /Telegram's default/);
});

test('a menu address has to be https', async () => {
  const proj = newProject('bot-menu-bad');
  await proj.cli(['init']);

  const out = await proj.cli(['bot', 'menu', 'http://example.com/app']);
  assert.notEqual(out.code, 0, 'an http address is refused');
  assert.match(out.out, /has to be https/);
});

test('empty profile text and unknown actions are refused', async () => {
  const proj = newProject('bot-bad');
  await proj.cli(['init']);

  const empty = await proj.cli(['bot', 'name', '   ']);
  assert.notEqual(empty.code, 0, 'an empty name is refused');
  assert.match(empty.out, /cannot be empty/);

  const unknown = await proj.cli(['bot', 'rename', 'x']);
  assert.notEqual(unknown.code, 0, 'an unknown action is refused');
  assert.match(unknown.out, /Unknown action/);

  const help = await proj.cli(['bot', '--help']);
  assert.equal(help.code, 0, help.out);
  assert.match(help.out, /tgpilot bot menu <url>/);
});

test('a refusal from Telegram keeps its own words', async () => {
  const proj = newProject('bot-refused');
  await proj.cli(['init']);

  const { callBotApi } = await import('../../src/api/botapi.js');

  // The mock refuses an unknown method the way Telegram does, and the error
  // arrives with Telegram's description rather than a stack trace.
  await assert.rejects(() => callBotApi(proj.token, 'definitelyNotAMethod', {}), /unknown method/);

  // A method Telegram does know still works from the same call path.
  const me = await callBotApi(proj.token, 'getMe', {});
  assert.equal(me.is_bot, true);
});
