// The Telegram update types the platform routes; a handler file named after
// the type is what switches that update on for the bot.
export const UPDATE_TYPES = [
  { type: 'message', handles: 'New incoming messages' },
  { type: 'edited_message', handles: 'An edited message' },
  { type: 'channel_post', handles: 'A new post in a channel' },
  { type: 'edited_channel_post', handles: 'An edited channel post' },
  { type: 'business_message', handles: 'A message from a connected business account' },
  { type: 'edited_business_message', handles: 'An edited business message' },
  { type: 'deleted_business_messages', handles: 'Deleted business messages' },
  { type: 'business_connection', handles: 'A business connection changed' },
  { type: 'message_reaction', handles: 'A reaction on a message changed' },
  { type: 'message_reaction_count', handles: 'Anonymous reaction counts changed' },
  { type: 'inline_query', handles: 'A new inline query' },
  { type: 'chosen_inline_result', handles: 'The chosen result of an inline query' },
  { type: 'callback_query', handles: 'A button press from an inline keyboard' },
  { type: 'shipping_query', handles: 'An incoming shipping query' },
  { type: 'pre_checkout_query', handles: 'An incoming pre-checkout query' },
  { type: 'purchased_paid_media', handles: 'A payment for purchased media' },
  { type: 'poll', handles: 'A poll stopped (non-quiz)' },
  { type: 'poll_answer', handles: 'A user changed their poll answer' },
  { type: 'my_chat_member', handles: 'The bot\'s own chat member status changed' },
  { type: 'chat_member', handles: 'A chat member\'s status changed' },
  { type: 'chat_join_request', handles: 'A new join request' },
];

// Starter file contents for `init` and `add`, one function per module kind.

export const SCHEMA_STARTER = `import { table, integer, text } from 'sdk/db';

// Tables are named exports in this file. Deploying it only registers the
// tables; the database changes when the pending migration is applied.
// Example:
// export const messages = table('messages', {
//   id:   integer('id').primaryKey({ autoIncrement: true }),
//   chat: integer('chat_id').notNull(),
//   text: text('text'),
// });
`;

export function handlerStarter(name) {
  if (name === 'message') {
    return `import { api } from 'sdk';

export default async function (message, ctx) {
  // The file name is the update type; the default export receives the payload.
  await api.sendMessage({
    chat_id: message.chat.id,
    text: \`You said: \${message.text ?? '(no text)'}\`,
  });
}
`;
  }
  return `import { api } from 'sdk';

export default async function (${name}, ctx) {
  // The payload shape depends on the update type; log it if unsure:
  // console.log(${name});
}
`;
}

export function endpointStarter(name) {
  return `import { db, EndpointError } from 'sdk';

// The Mini App calls this: Telegram.WebApp.Serverless.call('${name}', input, cb).
// input is the JSON object it sent; ctx.initData holds the verified user.
export default async function (input, ctx) {
  const user = ctx.initData.user;
  return { hello: user.first_name ?? 'stranger' };
}
`;
}

export function libStarter(name) {
  return `// Shared code. Handlers, endpoints and lib modules import it by a relative path.

export const ${name} = {
};
`;
}

export function moduleStarter(dir, name) {
  if (dir === 'handlers') return handlerStarter(name);
  if (dir === 'endpoints') return endpointStarter(name);
  if (dir === 'lib') return libStarter(name);
  return '';
}
