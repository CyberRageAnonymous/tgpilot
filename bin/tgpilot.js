#!/usr/bin/env node
import { main } from '../src/cli.js';

// A background failure (a socket that dies while we are waiting for it) must
// not take the tool down with a raw stack trace: say what happened instead.
process.on('unhandledRejection', (err) => {
  console.error(`Error: ${err?.message || String(err)}`);
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  console.error(`Error: ${err?.message || String(err)}`);
  process.exit(1);
});

try {
  const code = await main(process.argv.slice(2));
  process.exitCode = typeof code === 'number' ? code : 0;
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
