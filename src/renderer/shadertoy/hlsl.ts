import { translateHlslBody, fixHlslLiterals } from '../milkdrop/hlsl/Translator';
import { stripCommentsAndStrings } from './source';

/**
 * Lets shaders in the editor be written in HLSL instead of GLSL.
 *
 * The source-to-source rewriting itself is the same machinery that runs
 * MilkDrop 2's `warp_` and `comp_` shaders - the type names, the intrinsics,
 * the matrix-constructor transposition and the `mul` handling are identical
 * problems, and solving them twice would mean fixing every future bug twice.
 * What differs is only the surrounding interface: a MilkDrop shader writes to
 * `ret` against MilkDrop's sampler set, while one of these writes to
 * `fragColor` against the Shadertoy uniforms.
 *
 * This is not an HLSL compiler and does not pretend to be. It covers the
 * language as shader authors actually write it - vector types, the common
 * intrinsics, `tex2D` - and anything beyond that fails to compile with the
 * error pointing at the user's own line, which is a far more useful outcome
 * than silently producing something that renders incorrectly.
 */

/** Helpers that exist in HLSL but have no GLSL equivalent. */
export const HLSL_COMPAT = `float saturate_(float x) { return clamp(x, 0.0, 1.0); }
vec2  saturate_(vec2 v)  { return clamp(v, 0.0, 1.0); }
vec3  saturate_(vec3 v)  { return clamp(v, 0.0, 1.0); }
vec4  saturate_(vec4 v)  { return clamp(v, 0.0, 1.0); }
float rsqrt_(float x) { return inversesqrt(x); }
vec2  rsqrt_(vec2 v)  { return inversesqrt(v); }
vec3  rsqrt_(vec3 v)  { return inversesqrt(v); }
vec4  rsqrt_(vec4 v)  { return inversesqrt(v); }`;

/*
 * Tokens that are valid HLSL and invalid GLSL.
 *
 * Detection has to be certain in one direction: mistaking GLSL for HLSL would
 * rewrite a working shader. Every marker here is a compile error in GLSL ES, so
 * a shader containing one was never going to compile as GLSL anyway.
 */
const HLSL_MARKERS =
  /\b(float[234]|float[234]x[234]|half[234]?|tex2D|tex2Dlod|lerp|frac|saturate|rsqrt|ddx|ddy|atan2|fmod)\s*[(\s]/;

export type ShaderLanguage = 'glsl' | 'hlsl';

/**
 * Which language a pass is written in.
 *
 * An explicit `//! language = hlsl` directive always wins, because a shader
 * that mixes the two - HLSL that happens to contain no marker - should not
 * depend on a guess. Without one, the markers above decide.
 */
export function detectLanguage(source: string): ShaderLanguage {
  if (/^\s*\/\/!\s*language\s*=\s*hlsl\s*$/im.test(source)) return 'hlsl';
  if (/^\s*\/\/!\s*language\s*=\s*glsl\s*$/im.test(source)) return 'glsl';
  return HLSL_MARKERS.test(stripCommentsAndStrings(source)) ? 'hlsl' : 'glsl';
}

export interface HlslTranslation {
  glsl: string;
  warnings: string[];
}

/**
 * Rewrite HLSL into the GLSL the rest of the pipeline expects.
 *
 * Line-for-line wherever possible: the result is compiled with the user's
 * source line numbers still meaningful, so a compile error lands on the line
 * they wrote rather than somewhere in a generated file.
 */
export function translateShaderHlsl(source: string): HlslTranslation {
  const warnings: string[] = [];

  // The directive is ours, not HLSL's, and means nothing to the compiler.
  const withoutDirective = source.replace(
    /^\s*\/\/!\s*language\s*=\s*(hlsl|glsl)\s*$/gim,
    '//',
  );

  let glsl = translateHlslBody(withoutDirective, warnings);
  glsl = fixHlslLiterals(glsl);

  /*
   * HLSL writes `out float4 fragColor`; GLSL ES wants the qualifier before the
   * type, and `in` is implicit but harmless. The type rename has already turned
   * float4 into vec4 by this point.
   */
  glsl = glsl.replace(
    /\bvoid\s+mainImage\s*\(([^)]*)\)/,
    (_match, args: string) => {
      const fixed = args
        .replace(/\bout\s+vec4\b/, 'out vec4')
        .replace(/\bin\s+vec2\b/, 'in vec2');
      return `void mainImage(${fixed})`;
    },
  );

  return { glsl, warnings };
}
