// Unified line diffs, without any dependency. The middle section uses a
// dynamic-programming LCS inside a sane size guard; files bigger than that
// fall back to a single summary hunk instead of a maze of per-line changes.

const CONTEXT = 3;
const LCS_LIMIT = 2400 * 2400;

function splitLines(text) {
  if (text === '') return [];
  const lines = String(text).split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function trimEnds(a, b) {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tailA = a.length;
  let tailB = b.length;
  while (tailA > head && tailB > head && a[tailA - 1] === b[tailB - 1]) { tailA--; tailB--; }
  return { a: a.slice(head, tailA), b: b.slice(head, tailB), head };
}

// Returns [{ kind, line }] where kind is '-' for removed, '+' for added and
// ' ' for equal, or null when the input is too large for the LCS.
function lcsOps(a, b) {
  const n = a.length;
  const m = b.length;
  if (n * m > LCS_LIMIT) return null;

  const stride = m + 1;
  const dp = new Array((n + 1) * stride).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * stride + j] = a[i] === b[j]
        ? dp[(i + 1) * stride + j + 1] + 1
        : Math.max(dp[(i + 1) * stride + j], dp[i * stride + j + 1]);
    }
  }

  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ kind: ' ', line: a[i] }); i++; j++; continue; }
    if (dp[(i + 1) * stride + j] >= dp[i * stride + j + 1]) { ops.push({ kind: '-', line: a[i] }); i++; }
    else { ops.push({ kind: '+', line: b[j] }); j++; }
  }
  while (i < n) { ops.push({ kind: '-', line: a[i++] }); }
  while (j < m) { ops.push({ kind: '+', line: b[j++] }); }
  return ops;
}

export function computeDiff(oldText, newText, filename) {
  oldText = oldText ?? '';
  newText = newText ?? '';
  if (oldText === newText) return null;

  const linesA = splitLines(oldText);
  const linesB = splitLines(newText);
  const { a, b, head } = trimEnds(linesA, linesB);

  let mid = lcsOps(a, b) ?? [
    { kind: '-', line: `${a.length} line(s) replaced` },
    { kind: '+', line: `${b.length} line(s) replaced` },
  ];

  // The texts may differ only by a trailing newline; the line arrays then come
  // out equal. Show the last line with a "no newline" marker so the reader
  // still sees what changed.
  if (mid.length === 0) {
    mid = [
      { kind: '-', line: linesA[linesA.length - 1] ?? '' },
      { kind: '+', line: linesB[linesB.length - 1] ?? '' },
    ];
  }

  // Positions consumed on each side before each op index; an extra tail entry
  // reads the final position.
  const posA = new Array(mid.length + 1).fill(0);
  const posB = new Array(mid.length + 1).fill(0);
  for (let k = 0; k < mid.length; k++) {
    posA[k + 1] = posA[k];
    posB[k + 1] = posB[k];
    if (mid[k].kind !== '+') posA[k + 1]++;
    if (mid[k].kind !== '-') posB[k + 1]++;
  }

  const changed = [];
  for (let k = 0; k < mid.length; k++) {
    if (mid[k].kind !== ' ') changed.push(k);
  }

  // A hunk spans [start, end); each change gets CONTEXT equal lines of context
  // on either side, and changes close together share one hunk.
  const hunks = [];
  let active = null;
  for (const ci of changed) {
    if (!active) {
      active = { start: Math.max(0, ci - CONTEXT), last: ci };
      hunks.push(active);
      continue;
    }
    if (ci - active.last <= CONTEXT * 2) { active.last = ci; continue; }
    active = { start: Math.max(active.last + 1, ci - CONTEXT), last: ci };
    hunks.push(active);
  }

  const out = [`--- ${oldText === '' ? '/dev/null' : `a/${filename}`}`, `+++ ${newText === '' ? '/dev/null' : `b/${filename}`}`];

  for (const h of hunks) {
    const start = Math.max(0, h.start);
    const end = Math.min(mid.length, h.last + 1 + CONTEXT);
    const oldCount = posA[end] - posA[start];
    const newCount = posB[end] - posB[start];
    const oldStart = oldCount ? head + posA[start] + 1 : head + posA[start];
    const newStart = newCount ? head + posB[start] + 1 : head + posB[start];
    const oldPart = oldCount === 1 ? `${oldStart}` : `${oldStart},${oldCount}`;
    const newPart = newCount === 1 ? `${newStart}` : `${newStart},${newCount}`;
    out.push(`@@ -${oldPart} +${newPart} @@`);
    for (let k = start; k < end; k++) out.push(mid[k].kind + mid[k].line);
  }

  const missingFinalNewline =
    (oldText !== '' && !oldText.endsWith('\n')) || (newText !== '' && !newText.endsWith('\n'));
  if (missingFinalNewline) out.push('\\ No newline at end of file');

  return out.join('\n') + '\n';
}
