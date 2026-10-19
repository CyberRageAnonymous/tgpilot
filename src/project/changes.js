import { c } from '../colors.js';

// Database schema changes as the server reports them. Each change comes with a
// stable id (`kind:table.column` or `kind:table.index` or `kind:table`) that
// ends up in the apply request; the server computes the same string.

export function changeId(change) {
  const { kind, table, column, index } = change;
  if (column) return `${kind}:${table}.${column}`;
  if (index) return `${kind}:${table}.${index}`;
  return `${kind}:${table}`;
}

const LABELS = {
  create_table: 'new table',
  drop_table: 'drop table',
  change_table: 'change table',
  undocumented_table: 'not in schema',

  create_column: 'new column',
  drop_column: 'drop column',
  change_column: 'change column',
  undocumented_column: 'not in schema',

  create_index: 'new index',
  drop_index: 'drop index',
  change_index: 'change index',
  undocumented_index: 'not in schema',
};

export function kindLabel(change) {
  return LABELS[change.kind] || change.description || change.kind;
}

const MARKS = {
  create: { mark: '+', paint: c.green },
  drop: { mark: '✗', paint: c.red },
  change: { mark: '!', paint: c.yellow },
  undocumented: { mark: '?', paint: null },
};

function styleFor(change) {
  const verb = (change.kind || '').split('_')[0];
  return MARKS[verb] || { mark: '·', paint: null };
}

export function headerTarget(change) {
  if (change.column) return `${change.table}.${change.column}`;
  if (change.index) return `${change.table}.${change.index}`;
  return change.table;
}

export function briefSummary(dbChanges) {
  if (!dbChanges?.length) return '';
  const rows = dbChanges.map((change) => {
    const style = styleFor(change);
    return {
      mark: style.mark,
      target: headerTarget(change),
      label: kindLabel(change),
      paint: style.paint ?? ((x) => x),
    };
  });
  const width = Math.max(...rows.map((r) => r.target.length));
  return rows
    .map((r) => r.paint(`  ${r.mark}  ${r.target.padEnd(width)}  ${r.label}`))
    .join('\n');
}

// A fuller rendering of one change: header, body, reason and warning as
// provided by the server.
export function changeCard(change) {
  const lines = [c.cyan(`@@ ${headerTarget(change)}: ${kindLabel(change)} @@`)];

  const body = bodyLines(change);
  if (body.length) lines.push(...body);

  if (change.reason || change.action) {
    lines.push('');
    if (change.reason) lines.push(` Reason: ${change.reason}`);
    if (change.action) lines.push(` Action: ${change.action}`);
  }
  if (change.status === 'warning' && change.warning) {
    lines.push('');
    lines.push(`  ${c.yellow('Watch out: ')}${change.warning}`);
  }

  return lines.join('\n');
}

function bodyLines(change) {
  const lines = [];
  switch (change.kind) {
    case 'create_table':
      for (const part of sqlParts(change.sql)) lines.push(c.green(' ' + part));
      break;
    case 'create_column':
    case 'create_index':
      if (change.sql) lines.push(c.green(' ' + change.sql));
      break;
    case 'drop_table':
    case 'drop_column':
    case 'drop_index':
      if (change.sql) lines.push(c.red(' ' + change.sql));
      break;
    case 'change_table':
    case 'change_column':
    case 'change_index':
      if (change.diff) {
        lines.push(c.red('-' + change.diff.current));
        lines.push(c.green('+' + change.diff.expected));
      }
      break;
    case 'undocumented_table':
      for (const part of sqlParts(change.existing_schema)) lines.push(' ' + part);
      if (typeof change.row_count === 'number') {
        lines.push(` Contents: ${change.row_count} row${change.row_count === 1 ? '' : 's'}`);
      }
      break;
    case 'undocumented_column':
      if (change.diff?.current) lines.push(' ' + change.diff.current);
      break;
    case 'undocumented_index':
      for (const part of sqlParts(change.existing_schema)) lines.push(' ' + part);
      break;
    default:
      if (change.diff) {
        lines.push(c.red('-' + change.diff.current));
        lines.push(c.green('+' + change.diff.expected));
      }
      if (change.sql) lines.push(' ' + change.sql);
  }
  return lines;
}

function sqlParts(sql) {
  if (!sql) return [];
  const trimmed = sql.endsWith('\n') ? sql.slice(0, -1) : sql;
  return trimmed.split('\n');
}
