/**
 * Shadertoy import tests.
 *
 * Run with: npm run test:import
 *
 * The risky part of importing is not the fetch, it is the mapping: which pass
 * owns which buffer letter, and what each iChannel ends up bound to. Getting
 * that wrong produces a shader that compiles and renders the wrong thing, which
 * is far harder to notice than an outright failure.
 */
import {
  convertShadertoy,
  parseShadertoyId,
  attributionHeader,
  withAttribution,
  type ShadertoyShader,
} from '../src/renderer/shadertoy/ShadertoyImport';

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

/* ------------------------------ URL parsing ----------------------------- */

eq('full https URL', parseShadertoyId('https://www.shadertoy.com/view/XsXXDn'), 'XsXXDn');
eq('no www', parseShadertoyId('https://shadertoy.com/view/XsXXDn'), 'XsXXDn');
eq('no protocol', parseShadertoyId('www.shadertoy.com/view/XsXXDn'), 'XsXXDn');
eq('embed URL', parseShadertoyId('https://www.shadertoy.com/embed/XsXXDn'), 'XsXXDn');
eq('with query string', parseShadertoyId('https://www.shadertoy.com/view/XsXXDn?foo=1'), 'XsXXDn');
eq('trailing slash', parseShadertoyId('https://www.shadertoy.com/view/XsXXDn/'), 'XsXXDn');
eq('surrounding whitespace', parseShadertoyId('  https://www.shadertoy.com/view/XsXXDn  '), 'XsXXDn');
eq('bare id', parseShadertoyId('XsXXDn'), 'XsXXDn');
// People copy the embed snippet off a shader page far more often than they
// copy a clean URL, so the whole HTML blob has to work. The pattern is a
// search rather than a full match, which is what makes this fall out - locked
// in here so tightening it later cannot silently break pasting an iframe.
eq(
  'full iframe embed snippet',
  parseShadertoyId(
    '<iframe width="640" height="360" frameborder="0" ' +
      'src="https://www.shadertoy.com/embed/XtdGR7?gui=true&t=10&paused=true&muted=false" ' +
      'allowfullscreen></iframe>',
  ),
  'XtdGR7',
);
eq(
  'embed URL with playback params',
  parseShadertoyId('https://www.shadertoy.com/embed/XtdGR7?gui=true&t=10&paused=true'),
  'XtdGR7',
);
eq(
  'markdown link',
  parseShadertoyId('[cool shader](https://www.shadertoy.com/view/XtdGR7)'),
  'XtdGR7',
);
eq(
  'URL in a sentence',
  parseShadertoyId('check this out https://www.shadertoy.com/view/XtdGR7 pretty good'),
  'XtdGR7',
);

eq('rejects a non-shadertoy URL', parseShadertoyId('https://example.com/view/XsXXDn'), null);
eq('rejects prose', parseShadertoyId('please import my shader'), null);
eq('rejects empty', parseShadertoyId('   '), null);

/* --------------------------- pass + channel map ------------------------- */

const shader: ShadertoyShader = {
  info: { id: 'XsXXDn', name: 'Test Shader', username: 'someone' },
  renderpass: [
    {
      type: 'common',
      name: 'Common',
      code: 'float helper() { return 1.0; }',
    },
    {
      type: 'buffer',
      name: 'Buffer A',
      outputs: [{ id: 257, channel: 0 }],
      // Reads itself (feedback) on 0, live audio on 1.
      inputs: [
        { ctype: 'buffer', id: 257, channel: 0 },
        { ctype: 'musicstream', id: 12, channel: 1 },
      ],
      code: 'void mainImage(out vec4 o, in vec2 u) { o = vec4(1.0); }',
    },
    {
      type: 'buffer',
      name: 'Buffer B',
      outputs: [{ id: 258, channel: 0 }],
      inputs: [{ ctype: 'buffer', id: 257, channel: 0 }],
      code: 'void mainImage(out vec4 o, in vec2 u) { o = vec4(0.5); }',
    },
    {
      type: 'image',
      name: 'Image',
      outputs: [{ id: 37, channel: 0 }],
      inputs: [
        { ctype: 'buffer', id: 258, channel: 0 },
        { ctype: 'texture', id: 99, channel: 2 },
      ],
      code: 'void mainImage(out vec4 o, in vec2 u) { o = vec4(0.0); }',
    },
    { type: 'sound', name: 'Sound', code: 'vec2 mainSound(...) {}' },
  ],
};

const result = convertShadertoy(shader);

eq('name comes from info', result.name, 'Test Shader');
eq('common tab captured', result.doc.common, 'float helper() { return 1.0; }');
eq('pass ids and order', result.doc.passes.map((p) => p.id), ['A', 'B', 'Image']);
eq('sound pass is skipped', result.skipped.length, 1);
check('skip reason mentions Sound', result.skipped[0].includes('Sound'));

// Buffer A reads its own output id, which must resolve back to buffer A.
eq('buffer A self-reference', result.doc.passes[0].channels[0], { type: 'buffer', buffer: 'A' });
eq('musicstream becomes live audio', result.doc.passes[0].channels[1], { type: 'audio' });
eq('unused channel stays none', result.doc.passes[0].channels[3], { type: 'none' });

// Buffer B reads A's output id (257), not its own.
eq('buffer B reads buffer A', result.doc.passes[1].channels[0], { type: 'buffer', buffer: 'A' });

// Image reads B's output id (258).
eq('image reads buffer B', result.doc.passes[2].channels[0], { type: 'buffer', buffer: 'B' });
eq('texture substituted with noise', result.doc.passes[2].channels[2], { type: 'noise' });
check('texture substitution is warned about',
  result.warnings.some((w) => w.includes('texture') && w.includes('noise')));

/* --------------------- buffer letters from odd names -------------------- */

const oddNames = convertShadertoy({
  info: { name: 'Odd' },
  renderpass: [
    { type: 'buffer', name: 'my first pass', outputs: [{ id: 1 }], code: 'a' },
    { type: 'buffer', name: 'my second pass', outputs: [{ id: 2 }], code: 'b' },
    { type: 'image', name: 'Image', inputs: [{ ctype: 'buffer', id: 2, channel: 0 }], code: 'c' },
  ],
});
eq('non-standard buffer names get letters in order',
  oddNames.doc.passes.map((p) => p.id), ['A', 'B', 'Image']);
eq('input resolves to the right letter despite odd names',
  oddNames.doc.passes[2].channels[0], { type: 'buffer', buffer: 'B' });

// "Buf C" style abbreviations should be honoured rather than reallocated.
const abbreviated = convertShadertoy({
  info: { name: 'Abbrev' },
  renderpass: [
    { type: 'buffer', name: 'Buf C', outputs: [{ id: 9 }], code: 'a' },
    { type: 'image', name: 'Image', inputs: [{ ctype: 'buffer', id: 9, channel: 1 }], code: 'b' },
  ],
});
eq('"Buf C" keeps its letter', abbreviated.doc.passes[0].id, 'C');
eq('input resolves to C', abbreviated.doc.passes[1].channels[1], { type: 'buffer', buffer: 'C' });

/* ---------------------------- unsupported input ------------------------- */

const exotic = convertShadertoy({
  info: { name: 'Exotic' },
  renderpass: [
    {
      type: 'image',
      name: 'Image',
      inputs: [
        { ctype: 'keyboard', channel: 0 },
        { ctype: 'cubemap', channel: 1 },
        { ctype: 'webcam', channel: 2 },
        { ctype: 'video', channel: 3 },
      ],
      code: 'x',
    },
  ],
});
eq('keyboard left unbound', exotic.doc.passes[0].channels[0], { type: 'none' });
eq('cubemap left unbound', exotic.doc.passes[0].channels[1], { type: 'none' });
check('each unsupported input warns', exotic.warnings.length >= 4);

/* ------------------------------ audio notice ---------------------------- */

const silent = convertShadertoy({
  info: { name: 'Silent' },
  renderpass: [{ type: 'image', name: 'Image', inputs: [], code: 'x' }],
});
check('warns when a shader has no audio input',
  silent.warnings.some((w) => w.includes('will not react')));

const audible = convertShadertoy({
  info: { name: 'Audible' },
  renderpass: [
    { type: 'image', name: 'Image', inputs: [{ ctype: 'music', channel: 0 }], code: 'x' },
  ],
});
check('no audio warning when audio is present',
  !audible.warnings.some((w) => w.includes('will not react')));
eq('music maps to audio', audible.doc.passes[0].channels[0], { type: 'audio' });

/* ------------------------------- edge cases ----------------------------- */

const noImage = convertShadertoy({
  info: { name: 'Headless' },
  renderpass: [{ type: 'buffer', name: 'Buffer A', outputs: [{ id: 1 }], code: 'x' }],
});
check('warns when there is no Image pass',
  noImage.warnings.some((w) => w.includes('no Image pass')));

const empty = convertShadertoy({});
eq('empty shader yields no passes', empty.doc.passes.length, 0);
eq('empty shader still gets a fallback name', empty.name, 'Imported Shader');

const dangling = convertShadertoy({
  info: { name: 'Dangling' },
  renderpass: [
    { type: 'image', name: 'Image', inputs: [{ ctype: 'buffer', id: 999, channel: 0 }], code: 'x' },
  ],
});
eq('reference to a missing buffer is unbound',
  dangling.doc.passes[0].channels[0], { type: 'none' });
check('missing buffer warns',
  dangling.warnings.some((w) => w.includes('not imported')));

/* ------------------------------ attribution ----------------------------- */

const header = attributionHeader({ id: 'XsXXDn', name: 'Test Shader', username: 'someone' });
check('header credits the author', header.includes('someone'));
check('header links the source', header.includes('shadertoy.com/view/XsXXDn'));
check('header names the licence default', header.includes('CC BY-NC-SA'));

const attributed = withAttribution(convertShadertoy(shader));
const image = attributed.passes.find((p) => p.id === 'Image');
check('attribution is prepended to the Image pass', Boolean(image?.source.startsWith('// Imported from Shadertoy.')));
check('original code survives attribution', Boolean(image?.source.includes('void mainImage')));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
