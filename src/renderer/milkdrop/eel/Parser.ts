import { EelSyntaxError, TokenType, tokenize, type Token } from './Lexer';

/**
 * Precedence-climbing parser for NS-EEL2 producing a small AST.
 *
 * Precedence, loosest to tightest, matching NS-EEL2:
 *   =  +=  -=  *=  /=  %=  ^=      (right associative)
 *   ?:                              (right associative)
 *   ||
 *   &&
 *   |
 *   &
 *   ==  !=
 *   <  >  <=  >=
 *   +  -
 *   *  /  %
 *   unary -  +  !  ~
 *   ^                               (right associative, binds tighter than
 *                                    unary minus, so -2^2 is -4)
 */

export type Node =
  | { kind: 'Number'; value: number }
  | { kind: 'Var'; name: string }
  | { kind: 'Assign'; op: string; target: Node; value: Node }
  | { kind: 'Binary'; op: string; left: Node; right: Node }
  | { kind: 'Unary'; op: string; operand: Node }
  | { kind: 'Ternary'; cond: Node; then: Node; else: Node }
  | { kind: 'Call'; name: string; args: Node[] }
  | { kind: 'Sequence'; body: Node[] };

interface BinaryLevel {
  ops: string[];
  rightAssoc?: boolean;
}

const LEVELS: BinaryLevel[] = [
  { ops: ['||'] },
  { ops: ['&&'] },
  { ops: ['|'] },
  { ops: ['&'] },
  { ops: ['==', '!=', '==='] },
  { ops: ['<', '>', '<=', '>='] },
  { ops: ['+', '-'] },
  { ops: ['*', '/', '%'] },
];

const ASSIGN_OPS = ['=', '+=', '-=', '*=', '/=', '%=', '^=', '|=', '&='];

export class EelParser {
  private tokens: Token[];
  private index = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): Token {
    return this.tokens[this.index];
  }
  private next(): Token {
    return this.tokens[this.index++];
  }
  private at(type: TokenType, value?: string): boolean {
    const token = this.peek();
    return token.type === type && (value === undefined || token.value === value);
  }
  private eat(type: TokenType, value?: string): boolean {
    if (this.at(type, value)) {
      this.index++;
      return true;
    }
    return false;
  }
  private expect(type: TokenType, value?: string): Token {
    if (!this.at(type, value)) {
      const token = this.peek();
      throw new EelSyntaxError(
        `expected ${value ?? type}, found ${token.value || token.type}`,
        token.line,
        token.pos,
      );
    }
    return this.next();
  }

  /** Parse a whole code block: statements separated (and optionally trailed) by `;`. */
  parseProgram(): Node {
    const body: Node[] = [];
    while (!this.at(TokenType.EOF)) {
      // Tolerate stray and doubled semicolons; presets are full of them.
      if (this.eat(TokenType.Semicolon)) continue;
      body.push(this.parseExpression());
      if (!this.at(TokenType.EOF) && !this.at(TokenType.Semicolon)) {
        const token = this.peek();
        throw new EelSyntaxError(`unexpected ${token.value || token.type}`, token.line, token.pos);
      }
    }
    return { kind: 'Sequence', body };
  }

  parseExpression(): Node {
    return this.parseAssignment();
  }

  private parseAssignment(): Node {
    const left = this.parseTernary();
    const token = this.peek();
    if (token.type === TokenType.Operator && ASSIGN_OPS.includes(token.value)) {
      // Only variables and megabuf cells can be assigned to.
      if (left.kind !== 'Var' && !(left.kind === 'Call' && isBufferName(left.name))) {
        throw new EelSyntaxError('invalid assignment target', token.line, token.pos);
      }
      this.next();
      const value = this.parseAssignment();
      return { kind: 'Assign', op: token.value, target: left, value };
    }
    return left;
  }

  private parseTernary(): Node {
    const cond = this.parseBinary(0);
    if (this.at(TokenType.Operator, '?')) {
      this.next();
      const thenBranch = this.parseAssignment();
      this.expect(TokenType.Operator, ':');
      const elseBranch = this.parseAssignment();
      return { kind: 'Ternary', cond, then: thenBranch, else: elseBranch };
    }
    return cond;
  }

  private parseBinary(level: number): Node {
    if (level >= LEVELS.length) return this.parseUnary();

    let left = this.parseBinary(level + 1);
    const { ops } = LEVELS[level];

    for (;;) {
      const token = this.peek();
      if (token.type !== TokenType.Operator || !ops.includes(token.value)) break;
      this.next();
      const right = this.parseBinary(level + 1);
      left = { kind: 'Binary', op: token.value, left, right };
    }
    return left;
  }

  private parseUnary(): Node {
    const token = this.peek();
    if (token.type === TokenType.Operator && ['-', '+', '!', '~'].includes(token.value)) {
      this.next();
      const operand = this.parseUnary();
      if (token.value === '+') return operand;
      return { kind: 'Unary', op: token.value, operand };
    }
    return this.parsePower();
  }

  /**
   * `^` binds tighter than unary minus and is right-associative, so
   * `2^3^2` is 2^(3^2) = 512.
   */
  private parsePower(): Node {
    const base = this.parsePrimary();
    if (this.at(TokenType.Operator, '^')) {
      this.next();
      // Right operand goes through parseUnary so `2^-1` parses.
      const exponent = this.parseUnary();
      return { kind: 'Binary', op: '^', left: base, right: exponent };
    }
    return base;
  }

  private parsePrimary(): Node {
    const token = this.peek();

    if (token.type === TokenType.Number) {
      this.next();
      return { kind: 'Number', value: token.num ?? 0 };
    }

    if (token.type === TokenType.LParen) {
      this.next();
      // Parenthesised groups may hold a semicolon-separated sequence, which
      // NS-EEL evaluates left to right yielding the last value.
      const body: Node[] = [this.parseExpression()];
      while (this.eat(TokenType.Semicolon)) {
        if (this.at(TokenType.RParen)) break;
        body.push(this.parseExpression());
      }
      this.expect(TokenType.RParen);
      return body.length === 1 ? body[0] : { kind: 'Sequence', body };
    }

    if (token.type === TokenType.Identifier) {
      this.next();
      if (this.at(TokenType.LParen)) {
        this.next();
        const args: Node[] = [];
        if (!this.at(TokenType.RParen)) {
          args.push(this.parseExpression());
          while (this.eat(TokenType.Comma)) {
            args.push(this.parseExpression());
          }
          // `loop(4, a; b; c)` uses semicolons inside the final argument.
          while (this.eat(TokenType.Semicolon)) {
            if (this.at(TokenType.RParen)) break;
            args.push(this.parseExpression());
          }
        }
        this.expect(TokenType.RParen);
        return { kind: 'Call', name: token.value, args };
      }
      return { kind: 'Var', name: token.value };
    }

    throw new EelSyntaxError(`unexpected ${token.value || token.type}`, token.line, token.pos);
  }
}

export function isBufferName(name: string): boolean {
  return name === 'megabuf' || name === 'gmegabuf';
}

export function parseEel(source: string): Node {
  return new EelParser(source).parseProgram();
}

/** Collect every plain variable name an AST touches, for pre-seeding the scope. */
export function collectVariables(node: Node, out = new Set<string>()): Set<string> {
  switch (node.kind) {
    case 'Var':
      out.add(node.name);
      break;
    case 'Assign':
      collectVariables(node.target, out);
      collectVariables(node.value, out);
      break;
    case 'Binary':
      collectVariables(node.left, out);
      collectVariables(node.right, out);
      break;
    case 'Unary':
      collectVariables(node.operand, out);
      break;
    case 'Ternary':
      collectVariables(node.cond, out);
      collectVariables(node.then, out);
      collectVariables(node.else, out);
      break;
    case 'Call':
      for (const arg of node.args) collectVariables(arg, out);
      break;
    case 'Sequence':
      for (const stmt of node.body) collectVariables(stmt, out);
      break;
    default:
      break;
  }
  return out;
}
