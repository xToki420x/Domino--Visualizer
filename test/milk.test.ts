/**
 * .milk parser, serializer and HLSL translator tests.
 *
 * Run with: npm run test:milk
 *
 * The cases here are the ones that silently corrupt a preset rather than
 * failing loudly: numbered code lines reassembled in string order, backtick
 * markers left in shader source, and HLSL matrix constructors not transposed
 * into GLSL's column-major layout.
 */
import { parseMilk, serializeMilk } from '../src/renderer/milkdrop/MilkParser';
import { translateWarpShader, translateCompShader } from '../src/renderer/milkdrop/hlsl/Translator';

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed++;
  } else {
    console.log(`FAIL  ${label}${detail ? `\n      ${detail}` : ''}`);
    failed++;
  }
}

function eq(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(label, ok, ok ? undefined : `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

/* ----------------------------- basic parsing ---------------------------- */

const basic = parseMilk(
  [
    '[preset00]',
    'fDecay=0.955',
    'nWaveMode=3',
    'bAdditiveWaves=1',
    'zoom=1.020',
    'per_frame_1=a = 1;',
    'per_frame_2=b = 2;',
    'per_pixel_1=zoom = zoom + 0.01;',
    'unknown_key=keep me',
  ].join('\r\n'),
  'Basic',
);

eq('reads a float', basic.baseVals.fDecay, 0.955);
eq('reads an int', basic.baseVals.nWaveMode, 3);
eq('reads a bool as a number', basic.baseVals.bAdditiveWaves, 1);
eq('reads a lowercase key', basic.baseVals.zoom, 1.02);
eq('assembles per_frame', basic.perFrame, 'a = 1;\nb = 2;');
eq('assembles per_pixel', basic.perPixel, 'zoom = zoom + 0.01;');
eq('keeps unknown keys', basic.extra.unknown_key, 'keep me');
eq('defaults untouched vars', basic.baseVals.fGammaAdj, 2);

/* --------------- numeric ordering of numbered code lines ---------------- */

const ordered = parseMilk(
  [
    'per_frame_1=one',
    'per_frame_2=two',
    'per_frame_10=ten',
    'per_frame_9=nine',
    'per_frame_11=eleven',
  ].join('\n'),
);
eq(
  'numbered lines assemble in numeric, not string, order',
  ordered.perFrame,
  'one\ntwo\nnine\nten\neleven',
);

/* ---------------- lines out of order in the file ------------------------ */

const shuffled = parseMilk(['per_pixel_3=third', 'per_pixel_1=first', 'per_pixel_2=second'].join('\n'));
eq('out-of-order keys are sorted', shuffled.perPixel, 'first\nsecond\nthird');

/* ------------------------- values containing '=' ------------------------ */

const withEquals = parseMilk('per_frame_1=a = b == c;');
eq('only the first = separates key from value', withEquals.perFrame, 'a = b == c;');

/* ------------------------------- shaders -------------------------------- */

const shaderPreset = parseMilk(
  [
    'warp_1=`shader_body',
    'warp_2=`{',
    'warp_3=`   ret = tex2D(sampler_main, uv).xyz;',
    'warp_4=`}',
    'comp_1=`shader_body { ret = float3(1,0,0); }',
  ].join('\n'),
);
eq(
  'backtick markers are stripped from warp lines',
  shaderPreset.warpShader,
  'shader_body\n{\n   ret = tex2D(sampler_main, uv).xyz;\n}',
);
check('comp shader captured', shaderPreset.compShader.includes('float3(1,0,0)'));

/* ----------------------------- custom waves ----------------------------- */

const wavePreset = parseMilk(
  [
    'wavecode_0_enabled=1',
    'wavecode_0_samples=256',
    'wavecode_0_bSpectrum=1',
    'wavecode_0_bDrawThick=1',
    'wavecode_0_scaling=1.75000',
    'wavecode_0_r=0.500',
    'wave_0_per_point1=x = sample;',
    'wave_0_per_point2=y = value1;',
    'wave_0_per_frame1=t1 = 5;',
    'wavecode_2_enabled=1',
  ].join('\n'),
);
eq('wave enabled', wavePreset.waves[0].enabled, true);
eq('wave samples', wavePreset.waves[0].samples, 256);
eq('wave spectrum flag', wavePreset.waves[0].spectrum, true);
eq('wave thick flag', wavePreset.waves[0].drawThick, true);
eq('wave scaling', wavePreset.waves[0].scaling, 1.75);
eq('wave colour', wavePreset.waves[0].r, 0.5);
eq('wave per_point assembled', wavePreset.waves[0].perPoint, 'x = sample;\ny = value1;');
eq('wave per_frame assembled', wavePreset.waves[0].perFrame, 't1 = 5;');
eq('a second wave index is independent', wavePreset.waves[2].enabled, true);
eq('untouched wave stays disabled', wavePreset.waves[1].enabled, false);

/* ----------------------------- custom shapes ---------------------------- */

const shapePreset = parseMilk(
  [
    'shapecode_0_enabled=1',
    'shapecode_0_sides=7',
    'shapecode_0_num_inst=12',
    'shapecode_0_rad=0.25000',
    'shapecode_0_border_a=0.400',
    'shapecode_0_thickOutline=1',
    'shape_0_per_frame1=x = 0.5;',
  ].join('\n'),
);
eq('shape enabled', shapePreset.shapes[0].enabled, true);
eq('shape sides', shapePreset.shapes[0].sides, 7);
eq('shape instances', shapePreset.shapes[0].numInstances, 12);
eq('shape radius', shapePreset.shapes[0].rad, 0.25);
eq('shape border alpha', shapePreset.shapes[0].borderA, 0.4);
eq('shape thick outline', shapePreset.shapes[0].thickOutline, true);
eq('shape per_frame assembled', shapePreset.shapes[0].perFrame, 'x = 0.5;');

/* ------------------------------ round trip ------------------------------ */

const original = parseMilk(
  [
    'fDecay=0.930',
    'nWaveMode=5',
    'zoom=1.015',
    'wave_r=0.750',
    'wavecode_1_enabled=1',
    'wavecode_1_samples=128',
    'wave_1_per_point1=x = sample;',
    'shapecode_2_enabled=1',
    'shapecode_2_sides=9',
    'shape_2_per_frame1=rad = 0.3;',
    'per_frame_1=zoom = 1.01;',
    'per_frame_2=rot = 0.02;',
    'per_pixel_1=warp = 0.5;',
    'warp_1=`shader_body { ret = float3(0,0,0); }',
    'comp_1=`shader_body { ret = tex2D(sampler_main, uv).xyz; }',
  ].join('\n'),
  'RoundTrip',
);
const reparsed = parseMilk(serializeMilk(original), 'RoundTrip');

eq('round trip: decay', reparsed.baseVals.fDecay, original.baseVals.fDecay);
eq('round trip: wave mode', reparsed.baseVals.nWaveMode, original.baseVals.nWaveMode);
eq('round trip: zoom', reparsed.baseVals.zoom, original.baseVals.zoom);
eq('round trip: per_frame', reparsed.perFrame, original.perFrame);
eq('round trip: per_pixel', reparsed.perPixel, original.perPixel);
eq('round trip: warp shader', reparsed.warpShader, original.warpShader);
eq('round trip: comp shader', reparsed.compShader, original.compShader);
eq('round trip: wave enabled', reparsed.waves[1].enabled, true);
eq('round trip: wave samples', reparsed.waves[1].samples, 128);
eq('round trip: wave per_point', reparsed.waves[1].perPoint, original.waves[1].perPoint);
eq('round trip: shape sides', reparsed.shapes[2].sides, 9);
eq('round trip: shape per_frame', reparsed.shapes[2].perFrame, original.shapes[2].perFrame);

/* ---------------------------- line endings ------------------------------ */

const crlf = parseMilk('per_frame_1=a = 1;\r\nper_frame_2=b = 2;\r\n');
eq('CRLF line endings', crlf.perFrame, 'a = 1;\nb = 2;');
const cr = parseMilk('per_frame_1=a = 1;\rper_frame_2=b = 2;\r');
eq('bare CR line endings', cr.perFrame, 'a = 1;\nb = 2;');

/* --------------------------- HLSL translation --------------------------- */

function warpGlsl(body: string): string {
  return translateWarpShader(`shader_body { ${body} }`).glsl;
}

check('tex2D becomes texture', warpGlsl('ret = tex2D(sampler_main, uv).xyz;').includes('texture(sampler_main, uv)'));
check('float3 becomes vec3', warpGlsl('float3 c = float3(1,2,3);').includes('vec3 c = vec3(1,2,3)'));
check('lerp becomes mix', warpGlsl('ret = lerp(a, b, 0.5);').includes('mix(a, b, 0.5)'));
check('frac becomes fract', warpGlsl('float f = frac(x);').includes('fract(x)'));
check('fmod becomes mod', warpGlsl('float f = fmod(x, 2.0);').includes('mod(x, 2.0)'));
check('atan2 becomes atan', warpGlsl('float a = atan2(y, x);').includes('atan(y, x)'));
check('saturate is routed to a helper', warpGlsl('ret = saturate(c);').includes('saturate_(c)'));
check('rsqrt is routed to a helper', warpGlsl('float r = rsqrt(x);').includes('rsqrt_(x)'));
check('mul becomes a product', warpGlsl('ret = mul(a, b);').includes('((a) * (b))'));
check('clip becomes discard', warpGlsl('clip(x);').includes('discard'));

// The important one: HLSL fills matrices by row, GLSL by column.
const rot = warpGlsl('float2x2 m = float2x2(a, b, c, d);');
check(
  'float2x2 constructor is transposed for GLSL',
  rot.includes('mat2(a, c, b, d)'),
  rot.split('\n').find((l) => l.includes('mat2')),
);
const m3 = warpGlsl('float3x3 m = float3x3(a1,a2,a3,b1,b2,b3,c1,c2,c3);');
check(
  'float3x3 constructor is transposed for GLSL',
  m3.includes('mat3(a1, b1, c1, a2, b2, c2, a3, b3, c3)'),
  m3.split('\n').find((l) => l.includes('mat3')),
);

// Nested calls must not confuse the paren matcher.
check(
  'nested calls inside saturate survive',
  warpGlsl('ret = saturate(lerp(tex2D(sampler_main, uv).xyz, b, 0.5));').includes(
    'saturate_(mix(texture(sampler_main, uv).xyz, b, 0.5))',
  ),
);

check('shader_body wrapper is removed', !warpGlsl('ret = uv.xyy;').includes('shader_body'));
check('generated shader declares main()', warpGlsl('ret = uv.xyy;').includes('void main()'));
check('generated shader writes fragColor', warpGlsl('ret = uv.xyy;').includes('fragColor = vec4(ret'));
check('q1 alias is available', warpGlsl('ret = float3(q1, q2, q3);').includes('#define q1'));
check('GetBlur1 helper is defined', warpGlsl('ret = GetBlur1(uv);').includes('vec3 GetBlur1('));

// Scalar-to-vector assignment, which HLSL allows and GLSL does not.
check('ret = 0 becomes ret = vec3(0.0)', warpGlsl('ret = 0;').includes('ret = vec3(0.0);'));

// An empty preset still yields a usable default shader.
const defaultWarp = translateWarpShader('');
check('empty warp shader falls back to a default', defaultWarp.isDefault);
check('default warp applies decay', defaultWarp.glsl.includes('decay'));
const defaultComp = translateCompShader('');
check('empty comp shader falls back to a default', defaultComp.isDefault);
check('default comp applies video echo', defaultComp.glsl.includes('echo_alpha'));

/* ----------------------------- robustness ------------------------------- */

const junk = parseMilk('this line has no equals sign\n[section]\n\n\nfDecay=0.5\n');
eq('junk lines are skipped', junk.baseVals.fDecay, 0.5);

const badNumber = parseMilk('fDecay=not-a-number');
eq('unparseable numbers keep the default', badNumber.baseVals.fDecay, 0.98);
check('unparseable numbers produce a warning', badNumber.warnings.length > 0);

const emptyPreset = parseMilk('');
check('an empty file warns rather than throwing', emptyPreset.warnings.length > 0);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
