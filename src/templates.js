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
