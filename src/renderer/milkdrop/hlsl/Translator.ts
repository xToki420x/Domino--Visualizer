/**
 * Translates MilkDrop 2 pixel shaders (Direct3D HLSL, shader model 2/3) into
 * GLSL ES 3.00 so they can run on WebGL2.
 *
 * MilkDrop 2 presets embed `warp_1=` and `comp_1=` blocks containing HLSL of
 * the form:
 *
 *     shader_body {
 *         ret = tex2D(sampler_main, uv).xyz * 0.98;
 *     }
 *
 * The translation is source-to-source and deliberately pragmatic. It covers the
 * documented MilkDrop shader interface - the sampler set, the uniform set, the
 * GetBlur/GetPixel helpers - plus the HLSL intrinsics presets actually use. It
 * is not a general HLSL compiler, and it does not try to be: anything it cannot
 * handle fails to compile, the engine falls back to a passthrough shader, and
 * the error surfaces in the preset inspector rather than crashing the render.
 *
 * Two conversions are subtle and worth calling out:
 *
 *  - Matrix constructors are transposed. HLSL's `float2x2(a,b,c,d)` fills rows;
 *    GLSL's `mat2(a,b,c,d)` fills columns. Without transposing, every rotation
 *    in every preset spins the wrong way.
 *  - `mul(a, b)` becomes plain `a * b`, which is correct for both argument
 *    orders because GLSL defines vector*matrix as a row-vector product and
 *    matrix*vector as a column-vector product - exactly matching HLSL's `mul`.
 */

export interface TranslationResult {
  glsl: string;
  /** Lines of generated preamble, for mapping compile errors back to the preset. */
  prologueLines: number;
  warnings: string[];
  /** True when the source had no shader at all and we produced a default. */
  isDefault: boolean;
}

/* ------------------------- shared GLSL preamble ------------------------- */

/**
 * Every uniform MilkDrop exposes to preset shaders. Declaring the full set
 * unconditionally is simplest and costs nothing: unused uniforms are stripped
 * by the driver's optimiser, and a missing one would be a compile error in a
 * preset we would otherwise have rendered.
 */
const MILKDROP_UNIFORMS = `precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D sampler_main;
uniform sampler2D sampler_fc_main;
uniform sampler2D sampler_pc_main;
uniform sampler2D sampler_fw_main;
uniform sampler2D sampler_pw_main;
uniform sampler2D sampler_blur1;
uniform sampler2D sampler_blur2;
uniform sampler2D sampler_blur3;
uniform sampler2D sampler_noise_lq;
uniform sampler2D sampler_noise_mq;
uniform sampler2D sampler_noise_hq;
uniform sampler2D sampler_pw_noise_lq;
uniform sampler2D sampler_noisevol_lq;
uniform sampler2D sampler_noisevol_hq;

uniform vec4  texsize;
uniform vec4  texsize_noise_lq;
uniform vec4  texsize_noise_mq;
uniform vec4  texsize_noise_hq;
uniform vec4  aspect;
uniform vec4  rand_frame;
uniform vec4  rand_preset;
uniform vec4  roam_cos;
uniform vec4  roam_sin;
uniform vec4  slow_roam_cos;
uniform vec4  slow_roam_sin;

uniform float time;
uniform float fps;
uniform float frame;
uniform float progress;
uniform float bass;
uniform float mid;
uniform float treb;
uniform float bass_att;
uniform float mid_att;
uniform float treb_att;
uniform float vol;
uniform float vol_att;
uniform float gammaAdj;
uniform float decay;
// Crossfade weight, 1.0 except while blending between two presets.
uniform float blend_alpha;
uniform float echo_zoom;
uniform float echo_alpha;
uniform float echo_orient;
uniform float invert;
uniform float brighten;
uniform float darken;
uniform float solarize;

// Blur decode constants. MilkDrop stores blur textures scaled into 0..1, so
// they have to be expanded again on read - that is what GetBlurN() does.
uniform float scale1; uniform float bias1;
uniform float scale2; uniform float bias2;
uniform float scale3; uniform float bias3;

// Preset variables q1..q32, also exposed packed as _qa.._qh the way MilkDrop
// does, because many presets read them in vec4 form.
uniform vec4 _qa; uniform vec4 _qb; uniform vec4 _qc; uniform vec4 _qd;
uniform vec4 _qe; uniform vec4 _qf; uniform vec4 _qg; uniform vec4 _qh;
`;

/** q1..q32 aliases onto the packed vectors, plus MilkDrop's helper functions. */
const MILKDROP_HELPERS = `
#define q1  _qa.x
#define q2  _qa.y
#define q3  _qa.z
#define q4  _qa.w
#define q5  _qb.x
#define q6  _qb.y
#define q7  _qb.z
#define q8  _qb.w
#define q9  _qc.x
#define q10 _qc.y
#define q11 _qc.z
#define q12 _qc.w
#define q13 _qd.x
#define q14 _qd.y
#define q15 _qd.z
#define q16 _qd.w
#define q17 _qe.x
#define q18 _qe.y
#define q19 _qe.z
#define q20 _qe.w
#define q21 _qf.x
#define q22 _qf.y
#define q23 _qf.z
#define q24 _qf.w
#define q25 _qg.x
#define q26 _qg.y
#define q27 _qg.z
#define q28 _qg.w
#define q29 _qh.x
#define q30 _qh.y
#define q31 _qh.z
#define q32 _qh.w

float lum(vec3 c) { return dot(c, vec3(0.32, 0.49, 0.29)); }
float lum(vec4 c) { return dot(c.xyz, vec3(0.32, 0.49, 0.29)); }

vec3 GetPixel(vec2 uv)  { return texture(sampler_main, uv).xyz; }
vec3 GetBlur0(vec2 uv)  { return texture(sampler_main, uv).xyz; }
vec3 GetBlur1(vec2 uv)  { return texture(sampler_blur1, uv).xyz * scale1 + bias1; }
vec3 GetBlur2(vec2 uv)  { return texture(sampler_blur2, uv).xyz * scale2 + bias2; }
vec3 GetBlur3(vec2 uv)  { return texture(sampler_blur3, uv).xyz * scale3 + bias3; }

// HLSL intrinsics with no direct GLSL spelling.
float saturate_(float x) { return clamp(x, 0.0, 1.0); }
vec2  saturate_(vec2 x)  { return clamp(x, 0.0, 1.0); }
vec3  saturate_(vec3 x)  { return clamp(x, 0.0, 1.0); }
vec4  saturate_(vec4 x)  { return clamp(x, 0.0, 1.0); }
float rsqrt_(float x)    { return x > 0.0 ? inversesqrt(x) : 0.0; }
`;

/* ---------------------------- call rewriting ---------------------------- */

/**
 * Find each call to `name(` and rewrite it, handling nested parentheses.
 * A regex cannot do this correctly once arguments contain their own calls,
 * which they almost always do.
 */
function replaceCall(
  source: string,
  name: string,
  rewrite: (args: string[]) => string,
): string {
  let out = '';
  let i = 0;

  while (i < source.length) {
    const found = source.indexOf(name, i);
    if (found < 0) {
      out += source.slice(i);
      break;
    }

    // Must be a whole identifier followed by '('.
    const before = found > 0 ? source[found - 1] : '';
    const afterIndex = found + name.length;
    const isIdentChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
    if (isIdentChar(before) || source[afterIndex] !== '(') {
      out += source.slice(i, afterIndex);
      i = afterIndex;
      continue;
    }

    out += source.slice(i, found);

    // Walk to the matching close paren, splitting top-level commas.
    let depth = 0;
    let j = afterIndex;
    let argStart = afterIndex + 1;
    const args: string[] = [];
    for (; j < source.length; j++) {
      const c = source[j];
      if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0) {
          args.push(source.slice(argStart, j));
          break;
        }
      } else if (c === ',' && depth === 1) {
        args.push(source.slice(argStart, j));
        argStart = j + 1;
      }
    }

    if (depth !== 0) {
      // Unbalanced parentheses: leave the text alone and let the GLSL compiler
      // produce the error, which will point at the right place.
      out += source.slice(found);
      break;
    }

    out += rewrite(args.map((a) => a.trim()));
    i = j + 1;
  }

  return out;
}

/**
 * Transpose an HLSL matrix constructor's scalar arguments into GLSL's
 * column-major order.
 */
function transposeMatrixArgs(args: string[], n: number): string[] {
  if (args.length !== n * n) return args; // Not a scalar-per-element form.
  const out: string[] = [];
  for (let col = 0; col < n; col++) {
    for (let row = 0; row < n; row++) {
      out.push(args[row * n + col]);
    }
  }
  return out;
}

/* ------------------------------ translation ----------------------------- */

/** Extract the contents of `shader_body { ... }`, or return the source as-is. */
function extractShaderBody(source: string): string {
  const marker = /shader_body\s*\{/.exec(source);
  if (!marker) {
    // Some presets omit the wrapper entirely and just write statements.
    return source;
  }
  const start = marker.index + marker[0].length;
  let depth = 1;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i);
    }
  }
  // Unterminated block - take everything after the opening brace.
  return source.slice(start);
}

function translateBody(hlsl: string, warnings: string[]): string {
  let src = extractShaderBody(hlsl);

  // Strip HLSL storage qualifiers GLSL has no use for.
  src = src.replace(/\bstatic\s+const\b/g, 'const');
  src = src.replace(/\bstatic\b/g, '');
  src = src.replace(/\buniform\b/g, '');

  // Matrix constructors first: they must be transposed before the type rename
  // turns `float2x2` into `mat2`.
  for (const [hlslType, n, glslType] of [
    ['float4x4', 4, 'mat4'],
    ['float3x3', 3, 'mat3'],
    ['float2x2', 2, 'mat2'],
    ['half4x4', 4, 'mat4'],
    ['half3x3', 3, 'mat3'],
    ['half2x2', 2, 'mat2'],
  ] as const) {
    src = replaceCall(src, hlslType, (args) => {
      const transposed = transposeMatrixArgs(args, n);
      return `${glslType}(${transposed.join(', ')})`;
    });
  }

  // Intrinsics needing argument rewriting.
  src = replaceCall(src, 'mul', (args) =>
    args.length === 2 ? `((${args[0]}) * (${args[1]}))` : `(${args.join(', ')})`,
  );
  src = replaceCall(src, 'saturate', (args) => `saturate_(${args.join(', ')})`);
  src = replaceCall(src, 'rsqrt', (args) => `rsqrt_(${args.join(', ')})`);
  // clip(x) discards the fragment when x is negative.
  src = replaceCall(src, 'clip', (args) => `{ if ((${args[0] ?? '0.0'}) < 0.0) discard; }`);
  // tex2Dlod takes a float4 where zw carry the LOD; we only ever get uv.xy.
  src = replaceCall(src, 'tex2Dlod', (args) => {
    warnings.push('tex2Dlod was approximated with a plain texture fetch');
    return `texture(${args[0]}, (${args[1]}).xy)`;
  });

  // Straight identifier renames. Order matters only in that longer names must
  // be handled before their prefixes, which \b takes care of.
  const renames: Array<[RegExp, string]> = [
    [/\btex2D\b/g, 'texture'],
    [/\btex2d\b/g, 'texture'],
    [/\btex3D\b/g, 'texture'],
    [/\blerp\b/g, 'mix'],
    [/\bfrac\b/g, 'fract'],
    [/\bfmod\b/g, 'mod'],
    [/\batan2\b/g, 'atan'],
    [/\bddx\b/g, 'dFdx'],
    [/\bddy\b/g, 'dFdy'],
    [/\bfloat4\b/g, 'vec4'],
    [/\bfloat3\b/g, 'vec3'],
    [/\bfloat2\b/g, 'vec2'],
    [/\bfloat1\b/g, 'float'],
    [/\bhalf4\b/g, 'vec4'],
    [/\bhalf3\b/g, 'vec3'],
    [/\bhalf2\b/g, 'vec2'],
    [/\bhalf\b/g, 'float'],
    [/\bfloat4x4\b/g, 'mat4'],
    [/\bfloat3x3\b/g, 'mat3'],
    [/\bfloat2x2\b/g, 'mat2'],
    [/\bbool4\b/g, 'bvec4'],
    [/\bbool3\b/g, 'bvec3'],
    [/\bbool2\b/g, 'bvec2'],
    [/\bint4\b/g, 'ivec4'],
    [/\bint3\b/g, 'ivec3'],
    [/\bint2\b/g, 'ivec2'],
  ];
  for (const [pattern, replacement] of renames) {
    src = src.replace(pattern, replacement);
  }

  // HLSL lets a vector be assigned from a scalar; GLSL ES does not. `ret = 0;`
  // is common enough in real presets to be worth special-casing.
  src = src.replace(/\bret\s*=\s*(-?\d+(?:\.\d+)?)\s*;/g, (_m, num: string) => {
    const value = num.includes('.') ? num : `${num}.0`;
    return `ret = vec3(${value});`;
  });

  // A trailing `;;` from the clip() rewrite is harmless, but tidy it anyway.
  src = src.replace(/\}\s*;/g, '}');

  return src;
}

/**
 * Numeric literals like `.5` are legal in both languages, but HLSL's `1.f`
 * suffix is not valid GLSL.
 */
function fixLiterals(src: string): string {
  return src.replace(/(\d)[fF]\b/g, '$1.0').replace(/(\d\.)[fF]\b/g, '$10');
}

const WARP_VARYINGS = `
in vec2 vUv;
in vec2 vUvOrig;
in vec4 vColor;
in float vRad;
in float vAng;
out vec4 fragColor;
`;

const COMP_VARYINGS = `
in vec2 vUv;
in vec2 vUvOrig;
in vec4 vColor;
in float vRad;
in float vAng;
out vec4 fragColor;
`;

/**
 * The shader used when a preset has none (MilkDrop 1 presets) or when
 * translation fails. Applying `decay` here is what gives those presets their
 * trails, since without a custom warp shader MilkDrop does the fade itself.
 */
export const DEFAULT_WARP_HLSL = `shader_body {
  ret = tex2D(sampler_main, uv).xyz * decay;
}`;

/**
 * Composite shader for presets that have none (MilkDrop 1).
 *
 * MilkDrop applies video echo, gamma and the brighten/darken/solarize/invert
 * switches itself when a preset supplies no comp shader, so this reproduces
 * that fixed-function stage. MilkDrop 2 presets override it entirely.
 */
export const DEFAULT_COMP_HLSL = `shader_body {
  float2 uv_echo = (uv - 0.5) / echo_zoom + 0.5;
  if (echo_orient >= 2.0) uv_echo.y = 1.0 - uv_echo.y;
  if (fmod(echo_orient, 2.0) >= 1.0) uv_echo.x = 1.0 - uv_echo.x;

  float3 base = tex2D(sampler_main, uv).xyz;
  float3 echo = tex2D(sampler_main, uv_echo).xyz;
  ret = lerp(base, echo, echo_alpha);

  ret = ret * gammaAdj;
  if (brighten > 0.5) ret = sqrt(saturate(ret));
  if (darken > 0.5) ret = ret * ret;
  if (solarize > 0.5) ret = ret * (1.0 - ret) * 4.0;
  if (invert > 0.5) ret = 1.0 - ret;
}`;

function build(hlsl: string, varyings: string, warnings: string[]): TranslationResult {
  const body = fixLiterals(translateBody(hlsl, warnings));

  const prologue = `#version 300 es
${MILKDROP_UNIFORMS}${MILKDROP_HELPERS}${varyings}
void main() {
  vec2 uv = vUv;
  vec2 uv_orig = vUvOrig;
  float rad = vRad;
  float ang = vAng;
  vec3 hue_shader = vColor.rgb;
  vec4 _vDiffuse = vColor;
  vec3 ret = vec3(0.0);
`;

  const epilogue = `
  fragColor = vec4(ret, blend_alpha);
}
`;

  return {
    glsl: `${prologue}${body}${epilogue}`,
    prologueLines: prologue.split('\n').length - 1,
    warnings,
    isDefault: false,
  };
}

export function translateWarpShader(hlsl: string): TranslationResult {
  const warnings: string[] = [];
  const source = hlsl.trim() ? hlsl : DEFAULT_WARP_HLSL;
  const result = build(source, WARP_VARYINGS, warnings);
  result.isDefault = !hlsl.trim();
  return result;
}

export function translateCompShader(hlsl: string): TranslationResult {
  const warnings: string[] = [];
  const source = hlsl.trim() ? hlsl : DEFAULT_COMP_HLSL;
  const result = build(source, COMP_VARYINGS, warnings);
  result.isDefault = !hlsl.trim();
  return result;
}
