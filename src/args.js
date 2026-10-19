// A tiny argument parser for the command surface of this tool: `--flag`
// booleans, `--key value` or `--key=value` strings, and everything else left
// positional. Unknown names are errors, so typos never run silently.

export function parseArgs(argv, spec = {}) {
  const flagNames = new Set(spec.flags || []);
  const valueNames = new Set(spec.values || []);
  const out = { positional: [], flags: {}, values: {}, raw: argv };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];

    if (token === '--') {
      out.positional.push(...argv.slice(i + 1));
      break;
    }

    if (token.startsWith('--')) {
      const withEq = token.slice(2);
      const eq = withEq.indexOf('=');
      const key = eq === -1 ? withEq : withEq.slice(0, eq);

      if (valueNames.has(key)) {
        let value;
        if (eq !== -1) value = withEq.slice(eq + 1);
        else if (i + 1 < argv.length) value = argv[++i];
        else throw new Error(`--${key} needs a value`);
        out.values[key] = value;
        continue;
      }

      if (flagNames.has(key)) {
        if (eq !== -1) throw new Error(`--${key} does not take a value`);
        out.flags[key] = true;
        continue;
      }

      throw new Error(`Unknown option --${key}`);
    }

    if (token.startsWith('-') && token.length > 1) {
      const body = token.slice(1);
      const eq = body.indexOf('=');
      const key = eq === -1 ? body : body.slice(0, eq);
      if (valueNames.has(key)) {
        let value;
        if (eq !== -1) value = body.slice(eq + 1);
        else if (i + 1 < argv.length) value = argv[++i];
        else throw new Error(`-${key} needs a value`);
        out.values[key] = value;
        continue;
      }
      if (flagNames.has(key)) {
        if (eq !== -1) throw new Error(`-${key} does not take a value`);
        out.flags[key] = true;
        continue;
      }
      throw new Error(`Unknown option -${key}`);
    }

    out.positional.push(token);
  }

  return out;
}
