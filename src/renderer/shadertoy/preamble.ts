/**
 * The uniform block injected into every Shadertoy-style pass.
 *
 * The `i*` names are Shadertoy's, so shaders copied from shadertoy.com compile
 * unchanged. The audio block below them is Domino's addition - Shadertoy
 * exposes audio only as a texture, which means every shader that wants a bass
 * level has to reimplement band summing in GLSL. Handing over the analyser's
 * own numbers is both cheaper and far more musical, because they carry the
 * adaptive normalisation and beat tracking the CPU side already did.
 *
 * `iAudioData`, `iAudioLevel` and `iSensitivity` are aliases kept so shaders
 * written for the older CannaChromatic build still run.
 */
export const SHADERTOY_UNIFORMS = `precision highp float;
precision highp int;
precision highp sampler2D;

uniform vec3      iResolution;
uniform float     iTime;
uniform float     iTimeDelta;
uniform float     iFrameRate;
uniform int       iFrame;
uniform vec4      iMouse;
uniform vec4      iDate;
uniform float     iSampleRate;
uniform float     iChannelTime[4];
uniform vec3      iChannelResolution[4];
uniform sampler2D iChannel0;
uniform sampler2D iChannel1;
uniform sampler2D iChannel2;
uniform sampler2D iChannel3;

// ---- Domino audio uniforms -------------------------------------------
uniform sampler2D iAudioData;
uniform float     iBass;
uniform float     iMid;
uniform float     iTreb;
uniform float     iBassAtt;
uniform float     iMidAtt;
uniform float     iTrebAtt;
uniform float     iVolume;
uniform float     iVolumeAtt;
uniform float     iBeat;
uniform float     iBeatPulse;
uniform float     iBPM;
uniform float     iRMS;
uniform float     iPeak;
uniform float     iSensitivity;
uniform float     iAudioLevel;

// ---- Camera -------------------------------------------------------------
// Bind an iChannel to "webcam" to sample the live feed. These describe it.
uniform vec3      iCameraResolution;  // pixels; zero when no camera is running
uniform float     iCameraActive;      // 1.0 while a camera is streaming
uniform float     iCameraMirror;      // 1.0 when the user wants a selfie view

// Sample the camera with mirroring and aspect already handled. Pass the
// channel the webcam is bound to.
vec3 dominoCamera(sampler2D cam, vec2 uv) {
  if (iCameraMirror > 0.5) uv.x = 1.0 - uv.x;
  return texture(cam, uv).rgb;
}

// Convenience: spectrum/waveform lookups with the texture layout handled.
float dominoSpectrum(float x) { return texture(iAudioData, vec2(clamp(x, 0.0, 1.0), 0.25)).r; }
float dominoWave(float x)     { return texture(iAudioData, vec2(clamp(x, 0.0, 1.0), 0.75)).r * 2.0 - 1.0; }

// Names from before the app was renamed, kept so shaders written against the
// old API keep compiling. Cheap to carry, and breaking someone's saved shader
// over a rename would be gratuitous.
float milkySpectrum(float x) { return dominoSpectrum(x); }
float milkyWave(float x)     { return dominoWave(x); }
`;

/** Emitted when the user's code defines mainImage() instead of main(). */
export const MAIN_IMAGE_EPILOGUE = `
out vec4 domino_fragColor_out;
void main() {
  vec4 color = vec4(0.0, 0.0, 0.0, 1.0);
  mainImage(color, gl_FragCoord.xy);
  domino_fragColor_out = color;
}
`;

export type ShaderStyle = 'shadertoy' | 'raw-main' | 'complete';

/**
 * Decide how to treat a chunk of user source.
 *
 * - `complete`   already has its own #version directive; we hand it to the
 *                driver untouched so power users keep full control.
 * - `shadertoy`  defines mainImage(); we supply version, uniforms and a main().
 * - `raw-main`   defines main() but no #version; we supply version + uniforms
 *                and let it declare its own output.
 */
export function detectStyle(source: string): ShaderStyle {
  const stripped = stripCommentsAndStrings(source);
  if (/^\s*#version\s/m.test(stripped)) return 'complete';
  if (/\bmainImage\s*\(/.test(stripped)) return 'shadertoy';
  return 'raw-main';
}

/**
 * Remove comments before pattern-matching, so a `// void mainImage(...)` note
 * doesn't change how we wrap the shader.
 */
export function stripCommentsAndStrings(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

export interface BuiltShader {
  source: string;
  /** Lines added above the user's code, for mapping compile errors back. */
  prologueLines: number;
  style: ShaderStyle;
}

export function buildFragmentShader(userSource: string): BuiltShader {
  const style = detectStyle(userSource);

  if (style === 'complete') {
    return { source: userSource, prologueLines: 0, style };
  }

  const prologue = `#version 300 es\n${SHADERTOY_UNIFORMS}`;
  const needsOutput = style === 'shadertoy';

  // A raw-main shader declares its own `out`, so only the mainImage path gets
  // our output variable and generated main().
  const body = needsOutput
    ? `${prologue}\n${userSource}\n${MAIN_IMAGE_EPILOGUE}`
    : `${prologue}\n${userSource}`;

  return {
    source: body,
    prologueLines: prologue.split('\n').length,
    style,
  };
}
