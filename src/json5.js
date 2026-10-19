// A compact JSON5 parser and serializer for payloads typed on the command line
// and inside the web studio. It covers the practical language surface: quoted
// and unquoted keys, single and double quoted strings with full escapes,
// decimal and hex numbers, comments, and trailing commas.

const MAX_DEPTH = 512;
const WS = /\s/;
const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$\xa0-\uffff]/;
const UNICODE_WS = /[\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/;

export function parse(text) {
  const src = String(text);
  const p = new Cursor(src);
  p.skip();
  const value = p.value(0);
  p.skip();
  if (!p.eof()) p.fail('Unexpected content after the value');
  return value;
}

class Cursor {
  constructor(src) {
    this.s = src;
    this.i = 0;
  }

  eof() {
    return this.i >= this.s.length;
  }

  peek(k) {
    return this.s[this.i + (k || 0)];
  }

  skip() {
    for (;;) {
      while (this.i < this.s.length && (WHITESPACE.has(this.s[this.i]) || UNICODE_WS.test(this.s[this.i]))) this.i++;
      const c0 = this.peek();
      if (c0 === '/') {
        if (this.peek(1) === '/') {
          this.i += 2;
          while (!this.eof() && this.peek() !== '\n') this.i++;
          continue;
        }
        if (this.peek(1) === '*') {
          const end = this.s.indexOf('*/', this.i + 2);
          if (end === -1) this.fail('Unterminated comment');
          this.i = end + 2;
          continue;
        }
      }
      break;
    }
  }

  value(depth) {
    if (depth > MAX_DEPTH) this.fail('Too many nested values');
    const c0 = this.peek();
    if (c0 === '{') return this.object(depth);
    if (c0 === '[') return this.array(depth);
    if (c0 === '"' || c0 === "'") return this.string();
    if (c0 === '-' || c0 === '+' || (c0 >= '0' && c0 <= '9')) return this.number();
    if (IDENT_START.test(c0 ?? '')) return this.word();
    this.fail('Expected a value');
  }

  object(depth) {
    this.i++; // {
    const out = {};
    if (this.peek() === '}') { this.i++; return out; }
    for (;;) {
      this.skip();
      const key = this.key();
      this.skip();
      if (this.peek() !== ':') this.fail('Expected ":" after a key');
      this.i++;
      this.skip();
      const v = this.value(depth + 1);
      out[key] = v;
      this.skip();
      if (this.peek() === ',') {
        this.i++;
        this.skip();
        // Trailing commas are fine to accept, the way JSON5 reads them.
        if (this.peek() === '}') { this.i++; return out; }
        continue;
      }
      if (this.peek() === '}') { this.i++; return out; }
      this.fail('Expected "," or "}"');
    }
  }

  key() {
    const c0 = this.peek();
    if (c0 === '"' || c0 === "'") return this.string();
    if (IDENT_START.test(c0 ?? '')) {
      let j = this.i + 1;
      while (j < this.s.length && IDENT_PART.test(this.s[j])) j++;
      const name = this.s.slice(this.i, j);
      this.i = j;
      return name;
    }
    this.fail('Expected a key');
  }

  array(depth) {
    this.i++; // [
    const out = [];
    if (this.peek() === ']') { this.i++; return out; }
    for (;;) {
      this.skip();
      out.push(this.value(depth + 1));
      this.skip();
      if (this.peek() === ',') {
        this.i++;
        this.skip();
        if (this.peek() === ']') { this.i++; return out; }
        continue;
      }
      if (this.peek() === ']') { this.i++; return out; }
      this.fail('Expected "," or "]"');
    }
  }

  string() {
    const quote = this.peek();
    this.i++;
    let out = '';
    for (;;) {
      if (this.eof()) this.fail('Unterminated string');
      const ch = this.peek();
      if (ch === quote) { this.i++; return out; }
      if (ch === '\\') { out += this.escape(); continue; }
      out += ch;
      this.i++;
    }
  }

  escape() {
    this.i++; // the backslash
    if (this.eof()) this.fail('Unterminated escape');
    const ch = this.peek();
    switch (ch) {
      case 'b': this.i++; return '\b';
      case 't': this.i++; return '\t';
      case 'n': this.i++; return '\n';
      case 'f': this.i++; return '\f';
      case 'r': this.i++; return '\r';
      case 'v': this.i++; return '\v';
      case '0':
        if (!/[0-9]/.test(this.peek(1) ?? '')) { this.i++; return '\0'; }
        this.fail('Invalid escape');
        break;
      case 'x': {
        const hex = this.s.slice(this.i + 1, this.i + 3);
        if (!/^[0-9a-fA-F]{2}$/.test(hex)) this.fail('Invalid \\x escape');
        this.i += 3;
        return String.fromCharCode(parseInt(hex, 16));
      }
      case 'u': {
        const hex = this.s.slice(this.i + 1, this.i + 5);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail('Invalid \\u escape');
        this.i += 5;
        return String.fromCharCode(parseInt(hex, 16));
      }
      case '\n': this.i++; return '';
      case '\r':
        this.i++;
        if (this.peek() === '\n') this.i++;
        return '';
      default:
        // Identity escapes are allowed for anything else, so strings can keep
        // characters like "$" exactly as written.
        this.i++;
        return ch;
    }
  }

  number() {
    const start = this.i;
    if (this.peek() === '+' || this.peek() === '-') this.i++;
    if (this.s.startsWith('Infinity', this.i)) { this.i += 8; return (this.peekAt(start) === '-' ? -1 : 1) * Infinity; }
    if (this.s.startsWith('NaN', this.i)) { this.i += 3; return NaN; }
    if (/^0[xX]/.test(this.s.slice(this.i, this.i + 2))) {
      let j = this.i + 2;
      while (j < this.s.length && /[0-9a-fA-F]/.test(this.s[j])) j++;
      if (j === this.i + 2) this.fail('Missing hex digits');
      const value = parseInt(this.s.slice(this.i, j), 16);
      this.i = j;
      return this.s[start] === '-' ? -value : value;
    }
    let sawDigits = false;
    while (this.i < this.s.length && this.peek() >= '0' && this.peek() <= '9') { this.i++; sawDigits = true; }
    if (this.peek() === '.') {
      this.i++;
      while (this.i < this.s.length && this.peek() >= '0' && this.peek() <= '9') { this.i++; sawDigits = true; }
    }
    if (!sawDigits) this.fail('A number needs digits');
    if (this.peek() === 'e' || this.peek() === 'E') {
      this.i++;
      if (this.peek() === '+' || this.peek() === '-') this.i++;
      let expDigits = false;
      while (this.i < this.s.length && this.peek() >= '0' && this.peek() <= '9') { this.i++; expDigits = true; }
      if (!expDigits) this.fail('Missing exponent digits');
    }
    return Number(this.s.slice(start, this.i));
  }

  peekAt(offset) {
    return this.s[offset];
  }

  word() {
    for (const [word, value] of [['true', true], ['false', false], ['null', null], ['undefined', undefined]]) {
      if (this.s.startsWith(word, this.i)) {
        const after = this.peekAt(this.i + word.length);
        if (after === undefined || !IDENT_PART.test(after)) {
          this.i += word.length;
          return value;
        }
      }
    }
    this.fail('Unexpected identifier (strings need quotes)');
  }

  fail(message) {
    let line = 1;
    let column = 1;
    for (let k = 0; k < this.i; k++) {
      if (this.s[k] === '\n') { line++; column = 1; } else { column++; }
    }
    const near = this.s.slice(this.i, this.i + 24).replace(/\s+/g, ' ');
    throw new SyntaxError(`${message} at line ${line}, column ${column}${near ? ` (near: ${JSON.stringify(near)})` : ''}`);
  }
}

// Keep the skip() loop readable: ASCII whitespace is the common case, the
// remaining Unicode spaces are checked with UNICODE_WS above.
const WHITESPACE = new Set([' ', '\t', '\n', '\r', '\f', '\v']);

export function stringify(value) {
  return serialize(value);
}

function serialize(value) {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean': return String(value);
    case 'number': return String(value);
    case 'string': return JSON.stringify(value);
  }
  if (typeof value === 'object') {
    if (Array.isArray(value)) {
      return `[${value.map((v) => serialize(v)).join(',')}]`;
    }
    if (value instanceof Error) return `{"message":${JSON.stringify(value.message)}}`;
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    const body = entries.map(([k, v]) => `${keyText(k)}:${serialize(v)}`).join(',');
    return `{${body}}`;
  }
  if (typeof value === 'function') return `function ${value.name || ''}`;
  return String(value);
}

function keyText(key) {
  return IDENT_START.test(key[0] ?? '') && [...key].every((ch) => IDENT_PART.test(ch)) ? key : JSON.stringify(key);
}
