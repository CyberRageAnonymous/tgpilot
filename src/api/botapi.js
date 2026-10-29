import { runFunction } from './endpoints.js';

// Bot API calls do not go to api.telegram.org from here. The platform already
// holds the bot's credentials and exposes the same `api` proxy the handlers
// use, so a method is sent up as a tiny module and run in the isolate: the
// token never leaves the cloud, and the call travels the network this machine
// is configured to reach.

// Module names go to /run without a ".js" and inside a runnable directory —
// the same shape pathToModule produces for `tgpilot run`.
const CALL_MODULE = 'endpoints/tgpilot_botapi';
const PROFILE_MODULE = 'endpoints/tgpilot_profile';

const CALL_SOURCE = [
  "import { api } from 'sdk';",
  '',
  'export default async function (input) {',
  '  return await api[input.method](input.params || {});',
  '}',
  '',
].join('\n');

// The whole profile in one trip: five round trips for five fields would make
// the page feel slow for no reason.
const PROFILE_SOURCE = [
  "import { api } from 'sdk';",
  '',
  'export default async function () {',
  '  const [me, name, description, short, button] = await Promise.all([',
  '    api.getMe(),',
  '    api.getMyName(),',
  '    api.getMyDescription(),',
  '    api.getMyShortDescription(),',
  '    api.getChatMenuButton(),',
  '  ]);',
  '  return { me, name, description, short, button };',
  '}',
  '',
].join('\n');

// Runs one Bot API method and returns its `result`, exactly as the Bot API
// would hand it over. Anything the platform refuses arrives as an error with
// the Bot API's own code and description attached.
export async function callBotApi(token, method, params = {}) {
  const response = await runFunction(token, CALL_MODULE, { [CALL_MODULE]: CALL_SOURCE }, { method, params }, {});
  return response.result;
}

// The name, the two descriptions and the menu button, shaped the way the
// studio and the CLI show them.
export async function readBotProfile(token) {
  const response = await runFunction(token, PROFILE_MODULE, { [PROFILE_MODULE]: PROFILE_SOURCE }, {}, {});
  const { me, name, description, short, button } = response.result;
  return {
    username: me.username || '',
    id: me.id,
    name: name.name || '',
    description: description.description || '',
    short: short.short_description || '',
    menu: button?.menu_button || { type: 'default' },
  };
}
