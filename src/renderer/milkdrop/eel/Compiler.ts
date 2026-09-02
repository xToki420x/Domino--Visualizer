import { EelSyntaxError } from './Lexer';
import { collectVariables, parseEel, type Node } from './Parser';
import { EelRuntime, type EelBuffers, type EelScope } from './Runtime';

/**
 * Compiles NS-EEL source into a JavaScript function.
 *
 * Generating JS and handing it to `new Function` means preset equations run
 * through V8's optimising JIT rather than a tree-walking interpreter. That
 * matters enormously: per-pixel equations execute once per mesh vertex per
 * frame - at a 48x36 mesh and 60fps that is over 100,000 evaluations a second,
 * and an interpreter simply cannot keep up.
 *
 * This is not an injection risk despite the `new Function`. The generated text
 * is produced entirely from our own AST: identifiers only ever appear as
 * property names on a scope object, numbers are re-emitted from parsed floats,
 * and no source text is ever interpolated verbatim.
 */

/** Hard iteration caps so a malformed preset can't hang the render thread. */
const MAX_LOOP_ITERATIONS = 1_000_000;
const MAX_WHILE_ITERATIONS = 1_048_576;

export interface CompiledEel {
  /** Executes the code against a scope. Never throws. */
  run(scope: EelScope, buffers: EelBuffers): void;
  /** Every variable name referenced, for pre-seeding the scope with zeroes. */
  variables: Set<string>;
  /** Set when compilation failed; `run` is then a no-op. */
  error?: string;
  /** The generated JavaScript, exposed for the preset debugger. */
  generated?: string;
}

const NOOP: CompiledEel = {
  run: () => {},
  variables: new Set(),
};

/** Functions that map straight onto a runtime helper of the same arity. */
const DIRECT_FUNCTIONS: Record<string, { arity: number; helper: string }> = {
  sin: { arity: 1, helper: 'sin' },
  cos: { arity: 1, helper: 'cos' },
  tan: { arity: 1, helper: 'tan' },
  asin: { arity: 1, helper: 'asin' },
  acos: { arity: 1, helper: 'acos' },
  atan: { arity: 1, helper: 'atan' },
  atan2: { arity: 2, helper: 'atan2' },
  sqrt: { arity: 1, helper: 'sqrt' },
  sqr: { arity: 1, helper: 'sqr' },
  pow: { arity: 2, helper: 'pow' },
  exp: { arity: 1, helper: 'exp' },
  log: { arity: 1, helper: 'log' },
  log10: { arity: 1, helper: 'log10' },
  abs: { arity: 1, helper: 'abs' },
  sign: { arity: 1, helper: 'sign' },
  min: { arity: 2, helper: 'min' },
  max: { arity: 2, helper: 'max' },
  floor: { arity: 1, helper: 'floor' },
  ceil: { arity: 1, helper: 'ceil' },
  int: { arity: 1, helper: 'int' },
  frac: { arity: 1, helper: 'frac' },
  invsqrt: { arity: 1, helper: 'invsqrt' },
  rand: { arity: 1, helper: 'rand' },
  sigmoid: { arity: 2, helper: 'sigmoid' },
  bnot: { arity: 1, helper: 'bnot' },
  band: { arity: 2, helper: 'band' },
  bor: { arity: 2, helper: 'bor' },
  above: { arity: 2, helper: 'above' },
  below: { arity: 2, helper: 'below' },
  equal: { arity: 2, helper: 'eq' },
};

class CodeGenerator {
  private tempCounter = 0;
  /** Statements hoisted out of expressions (loops, whiles). */
  private hoisted: string[] = [];

  private temp(): string {
    return `_t${this.tempCounter++}`;
  }

  /** Compile a whole program to a JS function body. */
  program(node: Node): string {
    return this.stmts(node.kind === 'Sequence' ? node.body : [node]);
  }

  /**
   * Emit a list of statements, hoisting per statement rather than per block.
   *
   * Hoisting has to happen at this granularity: `a; loop(3, b); c` must run a,
   * then the loop, then c. Collecting every hoisted loop for the whole block
   * first would run the loop before `a`.
   */
  private stmts(nodes: Node[]): string {
    const lines: string[] = [];
    for (const node of nodes) {
      const { pre, value } = this.capture(() => this.expr(node));
      if (pre) lines.push(pre);
      lines.push(`${value};`);
    }
    return lines.join('\n');
  }

  /**
   * Evaluate `build` in a fresh hoist buffer and return the statements it
   * lifted out separately from the expression that uses them. Loops need real
   * JS statements but can appear anywhere an expression can.
   */
  private capture(build: () => string): { pre: string; value: string } {
    const saved = this.hoisted;
    this.hoisted = [];
    const value = build();
    const pre = this.hoisted.join('\n');
    this.hoisted = saved;
    return { pre, value };
  }

  expr(node: Node): string {
    switch (node.kind) {
      case 'Number':
        return formatNumber(node.value);

      case 'Var':
        return `v.${node.name}`;

      case 'Sequence': {
        if (node.body.length === 0) return '0';
        const parts = node.body.map((child) => this.expr(child));
        // Comma operator: evaluates left to right, yields the last value.
        return `(${parts.join(', ')})`;
      }

      case 'Unary': {
        const operand = this.expr(node.operand);
        switch (node.op) {
          case '-':
            return `(-(${operand}))`;
          case '!':
            return `(R.truthy(${operand}) ? 0 : 1)`;
          case '~':
            return `(~((${operand}) | 0))`;
          default:
            return operand;
        }
      }

      case 'Binary':
        return this.binary(node.op, node.left, node.right);

      case 'Ternary':
        return `(R.truthy(${this.expr(node.cond)}) ? (${this.expr(node.then)}) : (${this.expr(node.else)}))`;

      case 'Assign':
        return this.assign(node.op, node.target, node.value);

      case 'Call':
        return this.call(node.name, node.args);

      default:
        return '0';
    }
  }

  private binary(op: string, leftNode: Node, rightNode: Node): string {
    // && and || must short-circuit, so build them before evaluating the right
    // side into a string that would be emitted unconditionally.
    if (op === '&&') {
      return `(R.truthy(${this.expr(leftNode)}) ? (R.truthy(${this.expr(rightNode)}) ? 1 : 0) : 0)`;
    }
    if (op === '||') {
      return `(R.truthy(${this.expr(leftNode)}) ? 1 : (R.truthy(${this.expr(rightNode)}) ? 1 : 0))`;
    }

    const left = this.expr(leftNode);
    const right = this.expr(rightNode);

    switch (op) {
      case '+':
        return `((${left}) + (${right}))`;
      case '-':
        return `((${left}) - (${right}))`;
      case '*':
        return `((${left}) * (${right}))`;
      case '/':
        return `R.div(${left}, ${right})`;
      case '%':
        return `R.mod(${left}, ${right})`;
      case '^':
        return `R.pow(${left}, ${right})`;
      case '==':
      case '===':
        return `R.eq(${left}, ${right})`;
      case '!=':
        return `R.neq(${left}, ${right})`;
      case '<':
        return `((${left}) < (${right}) ? 1 : 0)`;
      case '>':
        return `((${left}) > (${right}) ? 1 : 0)`;
      case '<=':
        return `((${left}) <= (${right}) ? 1 : 0)`;
      case '>=':
        return `((${left}) >= (${right}) ? 1 : 0)`;
      case '&':
        return `(((${left}) | 0) & ((${right}) | 0))`;
      case '|':
        return `(((${left}) | 0) | ((${right}) | 0))`;
      default:
        return '0';
    }
  }

  private assign(op: string, target: Node, valueNode: Node): string {
    const value = this.expr(valueNode);

    // megabuf(i) = x  and  gmegabuf(i) = x
    if (target.kind === 'Call') {
      const buffer = target.name === 'gmegabuf' ? 'B.gmega' : 'B.mega';
      const index = target.args[0] ? this.expr(target.args[0]) : '0';
      if (op === '=') {
        return `R.setbuf(${buffer}, ${index}, ${value})`;
      }
      // Compound assignment has to read, combine and write back; stash the
      // index so it isn't evaluated twice (it may have side effects).
      const idxTemp = this.temp();
      this.hoisted.push(`const ${idxTemp} = ${index};`);
      const current = `R.getbuf(${buffer}, ${idxTemp})`;
      return `R.setbuf(${buffer}, ${idxTemp}, ${this.compound(op, current, value)})`;
    }

    if (target.kind !== 'Var') return '0';
    const slot = `v.${target.name}`;
    if (op === '=') {
      return `(${slot} = R.n(${value}))`;
    }
    return `(${slot} = R.n(${this.compound(op, slot, value)}))`;
  }

  private compound(op: string, current: string, value: string): string {
    switch (op) {
      case '+=':
        return `((${current}) + (${value}))`;
      case '-=':
        return `((${current}) - (${value}))`;
      case '*=':
        return `((${current}) * (${value}))`;
      case '/=':
        return `R.div(${current}, ${value})`;
      case '%=':
        return `R.mod(${current}, ${value})`;
      case '^=':
        return `R.pow(${current}, ${value})`;
      case '|=':
        return `(((${current}) | 0) | ((${value}) | 0))`;
      case '&=':
        return `(((${current}) | 0) & ((${value}) | 0))`;
      default:
        return value;
    }
  }

  private call(name: string, args: Node[]): string {
    switch (name) {
      // if() is a special form: only the taken branch may be evaluated, so it
      // cannot be a normal function call.
      case 'if': {
        const cond = args[0] ? this.expr(args[0]) : '0';
        const thenBranch = args[1] ? this.expr(args[1]) : '0';
        const elseBranch = args[2] ? this.expr(args[2]) : '0';
        return `(R.truthy(${cond}) ? (${thenBranch}) : (${elseBranch}))`;
      }

      case 'megabuf':
        return `R.getbuf(B.mega, ${args[0] ? this.expr(args[0]) : '0'})`;
      case 'gmegabuf':
        return `R.getbuf(B.gmega, ${args[0] ? this.expr(args[0]) : '0'})`;

      case 'assign': {
        const target = args[0];
        if (!target) return '0';
        return this.assign('=', target, args[1] ?? { kind: 'Number', value: 0 });
      }

      case 'exec2':
      case 'exec3': {
        const parts = args.map((arg) => this.expr(arg));
        return parts.length > 0 ? `(${parts.join(', ')})` : '0';
      }

      case 'loop': {
        // The count is evaluated once, in the enclosing scope, before looping.
        const countExpr = args[0] ? this.expr(args[0]) : '0';
        const counter = this.temp();
        const limit = this.temp();
        const bodyCode = this.stmts(args.slice(1));
        this.hoisted.push(
          `let ${limit} = (${countExpr}) | 0;`,
          `if (${limit} > ${MAX_LOOP_ITERATIONS}) ${limit} = ${MAX_LOOP_ITERATIONS};`,
          `for (let ${counter} = 0; ${counter} < ${limit}; ${counter}++) {`,
          bodyCode,
          `}`,
        );
        return '0';
      }

      case 'while': {
        // NS-EEL repeats the body while its final expression is non-zero, so
        // the condition must be re-evaluated inside the loop, after the body.
        const guard = this.temp();
        const cond = this.temp();
        const head = this.stmts(args.slice(0, -1));
        const last = args[args.length - 1];
        const tail = this.capture(() => (last ? this.expr(last) : '0'));
        this.hoisted.push(
          `let ${guard} = 0;`,
          `for (;;) {`,
          head,
          tail.pre,
          `const ${cond} = ${tail.value};`,
          `if (!R.truthy(${cond})) break;`,
          `if (++${guard} > ${MAX_WHILE_ITERATIONS}) break;`,
          `}`,
        );
        return '0';
      }

      default: {
        const direct = DIRECT_FUNCTIONS[name];
        if (direct) {
          const compiled: string[] = [];
          for (let i = 0; i < direct.arity; i++) {
            compiled.push(args[i] ? this.expr(args[i]) : '0');
          }
          return `R.${direct.helper}(${compiled.join(', ')})`;
        }
        // Unknown function: evaluate the arguments for their side effects and
        // yield 0, which is what NS-EEL does with an unresolved name.
        const evaluated = args.map((arg) => this.expr(arg));
        return evaluated.length > 0 ? `(${evaluated.join(', ')}, 0)` : '0';
      }
    }
  }
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  // Parenthesise so a negative literal can't fuse with a preceding operator.
  return Number.isInteger(value) ? `${value}` : `(${value})`;
}

const compileCache = new Map<string, CompiledEel>();

/**
 * Compile EEL source. Results are cached by source text, which pays off because
 * presets are re-selected constantly and blending compiles two presets at once.
 */
export function compileEel(source: string): CompiledEel {
  const trimmed = (source ?? '').trim();
  if (!trimmed) return NOOP;

  const cached = compileCache.get(trimmed);
  if (cached) return cached;

  let compiled: CompiledEel;
  try {
    const ast = parseEel(trimmed);
    const variables = collectVariables(ast);
    const body = new CodeGenerator().program(ast);

    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const factory = new Function('v', 'R', 'B', `"use strict";\n${body}`) as (
      v: EelScope,
      r: typeof EelRuntime,
      b: EelBuffers,
    ) => void;

    compiled = {
      variables,
      generated: body,
      run(scope, buffers) {
        try {
          factory(scope, EelRuntime, buffers);
        } catch {
          // A runtime fault in one frame's equations must not kill the render
          // loop; the preset simply keeps its previous values this frame.
        }
      },
    };
  } catch (err) {
    const message =
      err instanceof EelSyntaxError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    compiled = { run: () => {}, variables: new Set(), error: message };
  }

  // Bound the cache so a long session cycling thousands of presets can't grow
  // without limit.
  if (compileCache.size > 512) compileCache.clear();
  compileCache.set(trimmed, compiled);
  return compiled;
}

export function clearEelCache(): void {
  compileCache.clear();
}
