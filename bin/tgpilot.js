#!/usr/bin/env node
import { main } from '../src/cli.js';

try {
  const code = await main(process.argv.slice(2));
  process.exitCode = typeof code === 'number' ? code : 0;
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
