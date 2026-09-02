/**
 * NS-EEL compiler conformance tests.
 *
 * Run with: npm run test:eel
 *
 * These lock down the semantics that differ from JavaScript and that presets
 * depend on - epsilon equality, division by zero, `^` as exponentiation, lazy
 * `if()`, and statement ordering around hoisted loops.
 */
import { compileEel } from '../src/renderer/milkdrop/eel/Compiler';
import { MegaBuf, createScope, type EelBuffers } from '../src/renderer/milkdrop/eel/Runtime';

let passed = 0;
let failed = 0;

function run(src: string, seed: Record<string, number> = {}): Record<string, number> {
  const scope = createScope();
  const buffers: EelBuffers = { mega: new MegaBuf(), gmega: new MegaBuf() };
  const compiled = compileEel(src);
  if (compiled.error) throw new Error(`compile error: ${compiled.error}`);
  for (const name of compiled.variables) scope[name] = 0;
  Object.assign(scope, seed);
  compiled.run(scope, buffers);
  return scope as Record<string, number>;
}

function check(
  label: string,
  src: string,
  expect: Record<string, number>,
  seed: Record<string, number> = {},
): void {
  try {
    const scope = run(src, seed);
    for (const [key, want] of Object.entries(expect)) {
      const got = scope[key];
      if (!(Math.abs(got - want) < 1e-6)) {
        console.log(`FAIL  ${label}\n      ${key} = ${got}, expected ${want}`);
        failed++;
        return;
      }
    }
    passed++;
  } catch (err) {
    console.log(`FAIL  ${label}\n      threw: ${(err as Error).message}`);
    failed++;
  }
}

/* arithmetic and precedence */
check('basic arithmetic', 'x = 1 + 2 * 3;', { x: 7 });
check('parentheses', 'x = (1 + 2) * 3;', { x: 9 });
check('^ is pow, right assoc', 'x = 2^3^2;', { x: 512 });
check('^ binds tighter than unary -', 'x = -2^2;', { x: -4 });
check('negative exponent', 'x = 2^-1;', { x: 0.5 });
check('divide by zero yields 0', 'x = 5 / 0;', { x: 0 });
check('modulo', 'x = 7 % 3;', { x: 1 });
check('modulo by zero yields 0', 'x = 7 % 0;', { x: 0 });
check('leading-dot float', 'x = .5 + 0.25;', { x: 0.75 });
check('exponent literal', 'x = 1e2;', { x: 100 });
check('multiple statements', 'x = 1; y = 2; z = x + y;', { z: 3 });

/* comparison and logic */
check('less than', 'x = 1 < 2;', { x: 1 });
check('epsilon equality', 'x = (0.1 + 0.2) == 0.3;', { x: 1 });
check('not equal', 'x = 1 != 2;', { x: 1 });
check('&& short-circuits', 'y = 0; x = 0 && (y = 1);', { x: 0, y: 0 });
check('|| short-circuits', 'y = 0; x = 1 || (y = 1);', { x: 1, y: 0 });
check('bnot', 'x = bnot(0); y = bnot(5);', { x: 1, y: 0 });
check('above / below', 'x = above(3,2); y = below(3,2);', { x: 1, y: 0 });
check('unary not', 'x = !0; y = !3;', { x: 1, y: 0 });

/* conditionals */
check('ternary', 'x = 1 ? 10 : 20;', { x: 10 });
check('if() does not evaluate untaken branch', 'y = 0; x = if(0, (y = 1), 5);', { x: 5, y: 0 });
check('nested if()', 'x = if(above(3,2), if(1,7,8), 9);', { x: 7 });

/* assignment */
check('compound assignment', 'x = 5; x += 3; x *= 2;', { x: 16 });
check('chained assignment', 'x = y = 4;', { x: 4, y: 4 });
check('identifiers are case-insensitive', 'Foo = 3; x = FOO + foo;', { x: 6 });

/* functions */
check('rounding family', 'x = floor(3.7) + ceil(0.2) + abs(-2) + int(-3.9);', { x: 3 });
check('sqrt of negative yields 0', 'x = sqrt(-4);', { x: 0 });
check('log of zero yields 0', 'x = log(0);', { x: 0 });
check('atan2', 'x = atan2(1,1);', { x: Math.PI / 4 });
check('min and max', 'x = min(3, 5) + max(3, 5);', { x: 8 });
check('sqr', 'x = sqr(4);', { x: 16 });
check('asin clamps out-of-range input', 'x = asin(1.5);', { x: Math.PI / 2 });
check('unknown function yields 0', 'x = bogus(1,2);', { x: 0 });

/* constants */
check('$PI', 'x = $PI;', { x: Math.PI });
check('hex literal', 'x = $xFF;', { x: 255 });

/* megabuf */
check('megabuf round trip', 'megabuf(3) = 42; x = megabuf(3);', { x: 42 });
check('megabuf compound assign', 'megabuf(3) = 10; megabuf(3) += 5; x = megabuf(3);', { x: 15 });
check('assign() function form', 'assign(megabuf(7), 9); x = megabuf(7);', { x: 9 });
check('megabuf and gmegabuf are distinct', 'megabuf(1)=5; gmegabuf(1)=8; x=megabuf(1); y=gmegabuf(1);', {
  x: 5,
  y: 8,
});
check('megabuf out of range reads 0', 'x = megabuf(99999999);', { x: 0 });

/* control flow */
check('loop accumulates', 'x = 0; loop(5, x = x + 2);', { x: 10 });
check('loop runs in statement order', 'x = 1; loop(3, x = x * 2); x = x + 1;', { x: 9 });
check('statement before loop runs first', 'a = 1; b = 0; loop(2, b = b + 1); a = a + b;', { a: 3, b: 2 });
check('while loops until false', 'x = 0; while( x = x + 1; x < 5 );', { x: 5 });
check('exec2 yields last value', 'x = exec2(y = 3, y * 2);', { x: 6, y: 3 });
check('nested loops', 'x = 0; loop(3, loop(4, x = x + 1));', { x: 12 });
check('loop with multiple body statements', 'x=0; y=0; loop(3, x = x + 1; y = y + x);', { x: 3, y: 6 });

/* comments */
check('line comment', 'x = 5; // x = 9\n', { x: 5 });
check('block comment', 'x = /* nope */ 5;', { x: 5 });

/* robustness */
check('NaN is contained at assignment', 'x = 0/0; y = x + 1;', { x: 0, y: 1 });
check('stray semicolons tolerated', ';; x = 4;;;', { x: 4 });

/* a realistic per-frame block */
check(
  'realistic per_frame equations',
  `
  vol = (bass + mid + treb) * 0.333;
  wave_r = 0.5 + 0.5 * sin(time * 1.3);
  zoom = 1.0 + 0.02 * bass_att;
  rot = rot + 0.01 * (mid - 1);
  q1 = vol;
  `,
  { q1: 0.999, zoom: 1.02 },
  { bass: 1, mid: 1, treb: 1, bass_att: 1, time: 0, rot: 0 },
);

/* infinite-loop protection: this must terminate, not hang */
const guardStart = Date.now();
check('runaway while is capped', 'x = 0; while( x = x + 1; 1 );', {});
if (Date.now() - guardStart > 5000) {
  console.log('FAIL  runaway while took too long');
  failed++;
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
