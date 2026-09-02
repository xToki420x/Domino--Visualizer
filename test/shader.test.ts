/**
 * Shader document (multipass directive) tests.
 *
 * Run with: npm run test:shader
 *
 * The behaviour that matters most here is backward compatibility: a plain
 * shader, or anything pasted from Shadertoy, must keep working untouched.
 */
import {
  buildProject,
  defaultChannel,
  defaultChannels,
  parseShaderDocument,
  parseShaderProject,
  serializeShaderProject,
} from '../src/renderer/shadertoy/ShaderDocument';
import { buildFragmentShader, detectStyle } from '../src/renderer/shadertoy/preamble';

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

/* -------------------- plain shaders stay single pass -------------------- */

const plain = parseShaderDocument(
  'void mainImage(out vec4 o, in vec2 u) { o = vec4(1.0); }',
  'Plain',
);
eq('plain shader yields one pass', plain.project.passes.length, 1);
eq('plain shader pass is Image', plain.project.passes[0].id, 'Image');
eq('plain shader is not multipass', plain.multipass, false);
eq('plain shader gets audio on channel 0', plain.project.passes[0].channels[0], { type: 'audio' });
eq('plain shader keeps its source verbatim', plain.project.passes[0].source,
  'void mainImage(out vec4 o, in vec2 u) { o = vec4(1.0); }');

// A comment that merely mentions the directive syntax must not trigger it.
const decoy = parseShaderDocument('// see //!pass docs\nvoid mainImage(out vec4 o, in vec2 u) {}', 'D');
eq('a directive mid-line is not a directive', decoy.multipass, false);

/* ----------------------------- multipass -------------------------------- */

const multi = parseShaderDocument(
  [
    '// header comment, dropped',
    '//! common',
    'float helper() { return 1.0; }',
    '//! pass BufferA',
    '//! channel0 = bufferA',
    '//! channel1 = audio',
    'void mainImage(out vec4 o, in vec2 u) { o = vec4(helper()); }',
    '//! pass Image',
    '//! channel0 = bufferA',
    'void mainImage(out vec4 o, in vec2 u) { o = vec4(0.5); }',
  ].join('\n'),
  'Multi',
);

eq('multipass produces two passes', multi.project.passes.length, 2);
eq('multipass flag set', multi.multipass, true);
eq('buffer pass id', multi.project.passes[0].id, 'A');
eq('image pass id', multi.project.passes[1].id, 'Image');
check('common block is prepended to every pass',
  multi.project.passes.every((p) => p.source.includes('float helper()')));
eq('buffer pass channel0 binds itself', multi.project.passes[0].channels[0],
  { type: 'buffer', buffer: 'A' });
eq('buffer pass channel1 binds audio', multi.project.passes[0].channels[1], { type: 'audio' });
eq('image pass channel0 binds the buffer', multi.project.passes[1].channels[0],
  { type: 'buffer', buffer: 'A' });
check('header text before the first directive is dropped',
  !multi.project.passes[0].source.includes('header comment'));
eq('no warnings for a well-formed document', multi.warnings.length, 0);

/* --------------------------- pass name forms ---------------------------- */

for (const [spelling, expected] of [
  ['BufferA', 'A'], ['bufferA', 'A'], ['buffer_a', 'A'],
  ['B', 'B'], ['buf_c', 'C'], ['BufferD', 'D'],
  ['Image', 'Image'], ['image', 'Image'], ['main', 'Image'],
] as const) {
  const doc = parseShaderDocument(`//! pass ${spelling}\nvoid mainImage(out vec4 o, in vec2 u) {}`, 'X');
  eq(`pass name "${spelling}" resolves to ${expected}`, doc.project.passes[0]?.id, expected);
}

/* -------------------------- channel name forms -------------------------- */

for (const [spelling, expected] of [
  ['audio', { type: 'audio' }],
  ['fft', { type: 'audio' }],
  ['noise', { type: 'noise' }],
  ['none', { type: 'none' }],
  ['bufferB', { type: 'buffer', buffer: 'B' }],
  ['C', { type: 'buffer', buffer: 'C' }],
] as const) {
  const doc = parseShaderDocument(
    `//! pass Image\n//! channel2 = ${spelling}\nvoid mainImage(out vec4 o, in vec2 u) {}`,
    'X',
  );
  eq(`channel source "${spelling}"`, doc.project.passes[0].channels[2], expected);
}

/* ------------------------------ defaults -------------------------------- */

const defaults = parseShaderDocument(
  '//! pass BufferA\nvoid mainImage(out vec4 o, in vec2 u) {}\n//! pass Image\nvoid mainImage(out vec4 o, in vec2 u) {}',
  'X',
);
eq('undeclared buffer pass reads itself', defaults.project.passes[0].channels[0],
  { type: 'buffer', buffer: 'A' });
eq('undeclared image pass reads audio', defaults.project.passes[1].channels[0], { type: 'audio' });

/* ---------------------------- error handling ---------------------------- */

const badPass = parseShaderDocument('//! pass Nonsense\nvoid mainImage(out vec4 o, in vec2 u) {}', 'X');
check('unknown pass name warns', badPass.warnings.some((w) => w.includes('Nonsense')));

const badChannel = parseShaderDocument(
  '//! pass Image\n//! channel0 = wat\nvoid mainImage(out vec4 o, in vec2 u) {}',
  'X',
);
check('unknown channel warns', badChannel.warnings.some((w) => w.includes('wat')));
eq('unknown channel falls back to none', badChannel.project.passes[0].channels[0], { type: 'none' });

const dupe = parseShaderDocument(
  '//! pass Image\nvoid a() {}\n//! pass Image\nvoid b() {}',
  'X',
);
check('duplicate pass warns', dupe.warnings.some((w) => w.includes('more than once')));
eq('duplicate pass is not added twice', dupe.project.passes.length, 1);

const noImage = parseShaderDocument('//! pass BufferA\nvoid mainImage(out vec4 o, in vec2 u) {}', 'X');
check('missing Image pass warns', noImage.warnings.some((w) => w.includes('Image')));

const orphanChannel = parseShaderDocument('//! channel0 = audio\nvoid mainImage(out vec4 o, in vec2 u) {}', 'X');
check('channel before any pass is handled', orphanChannel.project.passes.length >= 1);

/* ------------------------- shader style detection ----------------------- */

eq('mainImage detected', detectStyle('void mainImage(out vec4 o, in vec2 u) {}'), 'shadertoy');
eq('raw main detected', detectStyle('out vec4 c;\nvoid main() { c = vec4(1.0); }'), 'raw-main');
eq('complete shader detected', detectStyle('#version 300 es\nvoid main() {}'), 'complete');
eq('commented-out mainImage does not count',
  detectStyle('// void mainImage(out vec4 o, in vec2 u) {}\nvoid main() {}'), 'raw-main');

/* --------------------------- prologue mapping --------------------------- */

const built = buildFragmentShader('void mainImage(out vec4 o, in vec2 u) {\n  o = vec4(1.0);\n}');
check('generated shader has a version directive', built.source.startsWith('#version 300 es'));
check('generated shader declares Shadertoy uniforms', built.source.includes('uniform vec3      iResolution;'));
check('generated shader declares Domino audio uniforms', built.source.includes('uniform float     iBass;'));
check('generated shader supplies main()', built.source.includes('void main()'));

// The prologue line count has to line up exactly, or every compile error in the
// editor points at the wrong line.
const lines = built.source.split('\n');
const userFirstLine = lines[built.prologueLines];
eq('prologueLines points at the first user line', userFirstLine,
  'void mainImage(out vec4 o, in vec2 u) {');

const complete = buildFragmentShader('#version 300 es\nvoid main() {}');
eq('complete shaders get no prologue', complete.prologueLines, 0);
eq('complete shaders are untouched', complete.source, '#version 300 es\nvoid main() {}');

/* --------------------------- project round trip -------------------------- */

const roundSource = [
  '//! common',
  'float helper() { return 2.0; }',
  '',
  '//! pass BufferA',
  '//! channel1 = audio',
  'void mainImage(out vec4 o, in vec2 u) { o = vec4(helper()); }',
  '',
  '//! pass BufferB',
  '//! channel0 = bufferA',
  '//! channel3 = noise',
  'void mainImage(out vec4 o, in vec2 u) { o = vec4(0.25); }',
  '',
  '//! pass Image',
  '//! channel0 = bufferB',
  '//! channel1 = audio',
  'void mainImage(out vec4 o, in vec2 u) { o = vec4(1.0); }',
].join('\n');

const first = parseShaderProject(roundSource);
const rewritten = serializeShaderProject(first.doc);
const second = parseShaderProject(rewritten);

eq('round trip: pass count', second.doc.passes.length, first.doc.passes.length);
eq('round trip: common block', second.doc.common, first.doc.common);
eq('round trip: pass ids', second.doc.passes.map((p) => p.id), ['A', 'B', 'Image']);
eq('round trip: sources', second.doc.passes.map((p) => p.source), first.doc.passes.map((p) => p.source));
eq('round trip: channels', second.doc.passes.map((p) => p.channels), first.doc.passes.map((p) => p.channels));
eq('round trip: no warnings', second.warnings.length, 0);

// Serialising twice must be stable, or saving repeatedly would churn the file.
eq('serialisation is idempotent', serializeShaderProject(second.doc), rewritten);

// Passes are emitted in render order regardless of how they were declared.
const unordered = parseShaderProject(
  ['//! pass Image', 'void a() {}', '//! pass BufferC', 'void b() {}'].join('\n'),
);
eq('passes sort into render order', unordered.doc.passes.map((p) => p.id), ['C', 'Image']);

/* ------------------------ plain shaders stay plain ----------------------- */

const plainSource = 'void mainImage(out vec4 o, in vec2 u) { o = vec4(1.0); }';
const plainDoc = parseShaderProject(plainSource);
eq('a plain shader serialises back to bare source',
  serializeShaderProject(plainDoc.doc), plainSource);

// Adding any structure must switch it to the directive form.
plainDoc.doc.passes.push({
  id: 'A',
  source: 'void mainImage(out vec4 o, in vec2 u) {}',
  channels: defaultChannels('A'),
});
check('adding a buffer switches to directive form',
  serializeShaderProject(plainDoc.doc).includes('//! pass BufferA'));

// A non-default binding on an otherwise plain shader must also be written out.
const rebound = parseShaderProject(plainSource);
rebound.doc.passes[0].channels[0] = { type: 'noise' };
check('a non-default channel forces directives',
  serializeShaderProject(rebound.doc).includes('//! channel0 = noise'));

/* --------------------------- default channels ---------------------------- */

eq('image channel0 defaults to audio', defaultChannel(0, 'Image'), { type: 'audio' });
eq('buffer channel0 defaults to itself', defaultChannel(0, 'B'), { type: 'buffer', buffer: 'B' });
eq('channel3 defaults to none', defaultChannel(3, 'Image'), { type: 'none' });

/* ---------------------------- build + offsets ---------------------------- */

const withCommon = parseShaderProject(
  ['//! common', 'float a();', 'float b();', '//! pass Image', 'void mainImage() {}'].join('\n'),
);
const builtProject = buildProject(withCommon.doc, 'X');
eq('common line count', builtProject.commonLineCount, 2);
check('common is prepended to the pass source',
  builtProject.project.passes[0].source.startsWith('float a();\nfloat b();\n'));

const noCommon = parseShaderProject('//! pass Image\nvoid mainImage() {}');
eq('no common means no offset', buildProject(noCommon.doc, 'X').commonLineCount, 0);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
