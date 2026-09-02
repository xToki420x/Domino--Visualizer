/**
 * Runtime support for compiled NS-EEL code.
 *
 * Two behaviours here are non-obvious but load-bearing for preset fidelity:
 *
 *  1. Division and modulo by zero yield 0 rather than Infinity/NaN. EEL is
 *     defined that way, and thousands of presets divide by variables that are
 *     zero on the first frame. Without this the whole scope turns to NaN and
 *     the preset renders black forever.
 *
 *  2. Truth and equality are epsilon-based, not exact. NS-EEL treats a value as
 *     true when |x| > 0.00001 and equal when the difference is below that same
 *     threshold, so accumulated float drift doesn't silently flip a condition.
 */

export const EEL_EPSILON = 0.00001;

/** Size of each megabuf. MilkDrop gives presets 1M slots; we match. */
export const MEGABUF_SIZE = 1048576;
/** Allocation granularity - megabufs are sparse, so grow in blocks. */
const BLOCK_SIZE = 65536;

/**
 * Sparse megabuf. Presets index anywhere in a million-element space but almost
 * always touch a few hundred slots, so allocating 8MB per preset up front would
 * be wasteful; blocks are created on first write.
 */
export class MegaBuf {
  private blocks: (Float64Array | undefined)[] = new Array(
    Math.ceil(MEGABUF_SIZE / BLOCK_SIZE),
  );

  get(index: number): number {
    const i = index | 0;
    if (i < 0 || i >= MEGABUF_SIZE) return 0;
    const block = this.blocks[(i / BLOCK_SIZE) | 0];
    return block ? block[i % BLOCK_SIZE] : 0;
  }

  set(index: number, value: number): number {
    const i = index | 0;
    if (i < 0 || i >= MEGABUF_SIZE) return value;
    const blockIndex = (i / BLOCK_SIZE) | 0;
    let block = this.blocks[blockIndex];
    if (!block) {
      block = new Float64Array(BLOCK_SIZE);
      this.blocks[blockIndex] = block;
    }
    block[i % BLOCK_SIZE] = value;
    return value;
  }

  clear(): void {
    this.blocks = new Array(Math.ceil(MEGABUF_SIZE / BLOCK_SIZE));
  }
}

export interface EelBuffers {
  mega: MegaBuf;
  gmega: MegaBuf;
}

/** Scope object holding preset variables. Always null-prototype. */
export type EelScope = Record<string, number>;

export function createScope(): EelScope {
  return Object.create(null) as EelScope;
}

/**
 * The helper object generated code calls into. Kept as plain functions on a
 * frozen object so V8 can inline them - these run millions of times a second
 * inside per-pixel equations.
 */
export const EelRuntime = {
  /** Clamp non-finite results to 0 so one bad frame can't poison the scope. */
  n(x: number): number {
    return Number.isFinite(x) ? x : 0;
  },

  div(a: number, b: number): number {
    return b === 0 ? 0 : a / b;
  },

  mod(a: number, b: number): number {
    const bi = b | 0;
    return bi === 0 ? 0 : (a | 0) % bi;
  },

  pow(a: number, b: number): number {
    const r = Math.pow(a, b);
    return Number.isFinite(r) ? r : 0;
  },

  truthy(x: number): boolean {
    return x > EEL_EPSILON || x < -EEL_EPSILON;
  },

  eq(a: number, b: number): number {
    return Math.abs(a - b) < EEL_EPSILON ? 1 : 0;
  },
  neq(a: number, b: number): number {
    return Math.abs(a - b) < EEL_EPSILON ? 0 : 1;
  },

  sqr(x: number): number {
    return x * x;
  },

  int(x: number): number {
    return Math.trunc(x);
  },

  frac(x: number): number {
    return x - Math.trunc(x);
  },

  invsqrt(x: number): number {
    return x <= 0 ? 0 : 1 / Math.sqrt(x);
  },

  /** NS-EEL log/log10 of a non-positive number is 0, not -Infinity. */
  log(x: number): number {
    return x > 0 ? Math.log(x) : 0;
  },
  log10(x: number): number {
    return x > 0 ? Math.log10(x) : 0;
  },
  sqrt(x: number): number {
    return x > 0 ? Math.sqrt(x) : 0;
  },

  /** Clamp asin/acos inputs; drift past 1.0 is common and would give NaN. */
  asin(x: number): number {
    return Math.asin(x < -1 ? -1 : x > 1 ? 1 : x);
  },
  acos(x: number): number {
    return Math.acos(x < -1 ? -1 : x > 1 ? 1 : x);
  },

  rand(x: number): number {
    // MilkDrop's rand(n) returns an integer in [0, n).
    const limit = Math.floor(x);
    return limit > 0 ? Math.floor(Math.random() * limit) : Math.random();
  },

  sigmoid(x: number, constraint: number): number {
    const t = 1 + Math.exp(-x * constraint);
    return t === 0 ? 0 : 1 / t;
  },

  bnot(x: number): number {
    return EelRuntime.truthy(x) ? 0 : 1;
  },
  band(a: number, b: number): number {
    return EelRuntime.truthy(a) && EelRuntime.truthy(b) ? 1 : 0;
  },
  bor(a: number, b: number): number {
    return EelRuntime.truthy(a) || EelRuntime.truthy(b) ? 1 : 0;
  },
  above(a: number, b: number): number {
    return a > b ? 1 : 0;
  },
  below(a: number, b: number): number {
    return a < b ? 1 : 0;
  },

  getbuf(buf: MegaBuf, index: number): number {
    return buf.get(index);
  },
  setbuf(buf: MegaBuf, index: number, value: number): number {
    return buf.set(index, Number.isFinite(value) ? value : 0);
  },

  min: Math.min,
  max: Math.max,
  abs: Math.abs,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  atan: Math.atan,
  atan2: Math.atan2,
  exp: Math.exp,
  floor: Math.floor,
  ceil: Math.ceil,
  sign: Math.sign,
} as const;

export type EelRuntimeType = typeof EelRuntime;
