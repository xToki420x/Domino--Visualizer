/**
 * Tokenizer for NS-EEL2, the expression language MilkDrop presets are written in.
 *
 * Notable divergences from C that trip people up:
 *  - Identifiers are case-insensitive (MilkDrop lowercases everything), so we
 *    fold case here and never think about it again downstream.
 *  - `^` is exponentiation, not xor.
 *  - `$xNN` is a hex literal and `$PI` / `$E` are named constants.
 *  - Both `//` and shell-style comments appear in the wild.
 */

export enum TokenType {
  Number = 'Number',
  Identifier = 'Identifier',
  Operator = 'Operator',
  LParen = 'LParen',
  RParen = 'RParen',
  Comma = 'Comma',
  Semicolon = 'Semicolon',
  EOF = 'EOF',
}

export interface Token {
  type: TokenType;
  value: string;
  /** Numeric value, for Number tokens. */
  num?: number;
  pos: number;
  line: number;
}

export class EelSyntaxError extends Error {
  readonly line: number;
  readonly pos: number;
  constructor(message: string, line: number, pos: number) {
    super(`line ${line}: ${message}`);
    this.name = 'EelSyntaxError';
    this.line = line;
    this.pos = pos;
  }
}

/** Longest-first so `<=` wins over `<`, `**` over `*`, and so on. */
const OPERATORS = [
  '===',
  '!==',
  '==',
  '!=',
  '<=',
  '>=',
  '&&',
  '||',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '^=',
  '|=',
  '&=',
  '<',
  '>',
  '+',
  '-',
  '*',
  '/',
  '%',
  '^',
  '=',
  '!',
  '?',
  ':',
  '&',
  '|',
  '~',
];

const NAMED_CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  e: Math.E,
  phi: (1 + Math.sqrt(5)) / 2,
};

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  const n = source.length;

  while (i < n) {
    const c = source[i];

    if (c === '\n') {
      line++;
      i++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v') {
      i++;
      continue;
    }

    // Comments: // to end of line, /* */ block.
    if (c === '/' && source[i + 1] === '/') {
      while (i < n && source[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') line++;
        i++;
      }
      i += 2;
      continue;
    }

    // $xNN hex literals and $PI / $E named constants.
    if (c === '$') {
      const start = i;
      i++;
      if (source[i] === 'x' || source[i] === 'X') {
        i++;
        const hexStart = i;
        while (i < n && /[0-9a-fA-F]/.test(source[i])) i++;
        const text = source.slice(hexStart, i);
        tokens.push({
          type: TokenType.Number,
          value: source.slice(start, i),
          num: text ? parseInt(text, 16) : 0,
          pos: start,
          line,
        });
        continue;
      }
      const nameStart = i;
      while (i < n && /[a-zA-Z_]/.test(source[i])) i++;
      const name = source.slice(nameStart, i).toLowerCase();
      tokens.push({
        type: TokenType.Number,
        value: source.slice(start, i),
        num: NAMED_CONSTANTS[name] ?? 0,
        pos: start,
        line,
      });
      continue;
    }

    // Numbers. A leading '.' is legal ('.5'), and we accept exponents.
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(source[i + 1] ?? ''))) {
      const start = i;
      while (i < n && /[0-9]/.test(source[i])) i++;
      if (source[i] === '.') {
        i++;
        while (i < n && /[0-9]/.test(source[i])) i++;
      }
      if (source[i] === 'e' || source[i] === 'E') {
        const save = i;
        i++;
        if (source[i] === '+' || source[i] === '-') i++;
        if (/[0-9]/.test(source[i] ?? '')) {
          while (i < n && /[0-9]/.test(source[i])) i++;
        } else {
          i = save; // Not actually an exponent; e.g. `2e` followed by nothing.
        }
      }
      const text = source.slice(start, i);
      tokens.push({ type: TokenType.Number, value: text, num: parseFloat(text), pos: start, line });
      continue;
    }

    if (/[a-zA-Z_]/.test(c)) {
      const start = i;
      while (i < n && /[a-zA-Z0-9_.]/.test(source[i])) i++;
      // Case folding happens here so the rest of the pipeline can use strict
      // string equality on names.
      tokens.push({
        type: TokenType.Identifier,
        value: source.slice(start, i).toLowerCase(),
        pos: start,
        line,
      });
      continue;
    }

    if (c === '(') {
      tokens.push({ type: TokenType.LParen, value: '(', pos: i, line });
      i++;
      continue;
    }
    if (c === ')') {
      tokens.push({ type: TokenType.RParen, value: ')', pos: i, line });
      i++;
      continue;
    }
    if (c === ',') {
      tokens.push({ type: TokenType.Comma, value: ',', pos: i, line });
      i++;
      continue;
    }
    if (c === ';') {
      tokens.push({ type: TokenType.Semicolon, value: ';', pos: i, line });
      i++;
      continue;
    }

    const op = OPERATORS.find((candidate) => source.startsWith(candidate, i));
    if (op) {
      tokens.push({ type: TokenType.Operator, value: op, pos: i, line });
      i += op.length;
      continue;
    }

    // Presets in the wild contain stray characters (smart quotes pasted from
    // forums, mostly). Skipping beats refusing to load the preset at all.
    i++;
  }

  tokens.push({ type: TokenType.EOF, value: '', pos: i, line });
  return tokens;
}
