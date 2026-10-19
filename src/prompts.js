import readline from 'readline';
import { Writable } from 'stream';
import { c } from './colors.js';

export const EOF = Symbol('eof');

// TTY-aware prompting. Every command that opens prompts must call
// closePrompts() in the end, or a pending interface keeps the process alive
// after the work is done.

const INTERACTIVE =
  process.stdout.isTTY === true || process.env.TGPILOT_ASSUME_TTY === '1' || process.env.TGCLOUD_ASSUME_TTY === '1';

export function isInteractive() {
  return INTERACTIVE;
}

let shared = null;
const open = new Set();

function iface() {
  if (!shared) {
    shared = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: process.stdin.isTTY === true,
    });
    open.add(shared);
  }
  return shared;
}

export function closePrompts() {
  for (const rl of open) { try { rl.close(); } catch { /* already dead */ } }
  open.clear();
  shared = null;
}

function ask(question) {
  const rl = iface();
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    rl.question(question, (answer) => done(answer));
    rl.once('close', () => done(EOF));
  });
}

export async function confirm(question) {
  const answer = await ask(`  ${question} [y/N] `);
  if (answer === EOF) return false;
  const v = String(answer || '').trim().toLowerCase();
  return v === 'y' || v === 'yes';
}

export async function askLetter(question, choices) {
  const keys = choices.map((it) => `${it.key}=${it.label}`).join(', ');
  for (;;) {
    const answer = await ask(`  ${question} (${keys}) `);
    if (answer === EOF) return EOF;
    const v = String(answer || '').trim().toLowerCase();
    if (choices.some((it) => it.key === v)) return v;
    console.log(c.yellow(`  Answer with one of: ${keys}`));
  }
}

export async function askHidden(question) {
  // A swallowing stream stands in for the terminal, so readline can keep
  // accepting keys without ever echoing them.
  const mute = new Writable({
    write(_chunk, _enc, cb) { cb(); },
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: mute,
    terminal: process.stdin.isTTY === true,
  });

  process.stdout.write(question);

  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      rl.close();
      resolve(v);
    };
    rl.once('close', () => done(EOF));
    rl.once('SIGINT', () => { process.stdout.write('\n'); done(EOF); });
    rl.question('', (answer) => {
      process.stdout.write('\n');
      done(answer);
    });
  });
}

export async function waitForEnter(question) {
  await ask(`  ${question}`);
}
