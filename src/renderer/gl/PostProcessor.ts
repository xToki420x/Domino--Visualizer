import type { GLContext } from './GLContext';
import { Program } from './Program';
import { FullscreenQuad, FULLSCREEN_VERT } from './Quad';

/**
 * Final image stage, applied to whatever the active engine produced.
 *
 * This exists mainly to solve blowout. Both the MilkDrop engine and Shadertoy
 * shaders happily produce values well above 1.0 - feedback buffers accumulate,
 * MilkDrop's `gammaAdj` is a straight multiplier, and additive waves stack.
 * Writing those to an 8-bit display just clips every channel to 255, which is
 * why an unmanaged visualizer turns into a white smear on loud passages.
 *
 * Rendering the scene into a float buffer and running a filmic tone-map here
 * rolls highlights off smoothly instead of clipping them, so detail survives in
 * the bright areas and the picture stops screaming. Exposure, contrast,
 * saturation and vignette then sit on top as user controls.
 */

export interface PostSettings {
  /** Linear exposure multiplier applied before tone mapping. */
  brightness: number;
  contrast: number;
  saturation: number;
  /** Display gamma trim. 1.0 leaves the tone-mapped result alone. */
  gamma: number;
  /** Filmic highlight roll-off. Off means straight clipping, MilkDrop-style. */
  toneMap: boolean;
  vignette: number;
}

export const DEFAULT_POST: PostSettings = {
  // Slightly under 1.0: most presets are authored hot, and this reads as
  // "correct" rather than "dimmed" once the tone-map is doing its job.
  brightness: 0.85,
  contrast: 1.0,
  saturation: 1.0,
  gamma: 1.0,
  toneMap: true,
  vignette: 0.12,
};

const POST_FRAGMENT = `#version 300 es
precision highp float;

uniform sampler2D uScene;
uniform float uBrightness;
uniform float uContrast;
uniform float uSaturation;
uniform float uGamma;
uniform float uVignette;
uniform float uToneMap;

in vec2 vUv;
out vec4 fragColor;

/*
 * ACES filmic tone-map (Narkowicz's fit).
 *
 * Cheap, and it does the one thing that matters here: it is asymptotic, so no
 * input value however large ever clips hard to white. Bright cores keep their
 * hue instead of blowing out to a flat disc.
 */
vec3 acesFilmic(vec3 x) {
  const float a = 2.51;
  const float b = 0.03;
  const float c = 2.43;
  const float d = 0.59;
  const float e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

void main() {
  vec3 color = texture(uScene, vUv).rgb;

  // Guard against NaN from a misbehaving preset; without this a single bad
  // pixel propagates through the filter taps as black or white noise.
  color = mix(vec3(0.0), color, step(vec3(-1e20), color) * step(color, vec3(1e20)));

  color = max(color * uBrightness, 0.0);

  if (uToneMap > 0.5) {
    color = acesFilmic(color);
  } else {
    color = clamp(color, 0.0, 1.0);
  }

  // Contrast pivots around mid-grey so it doesn't shift overall exposure.
  color = clamp((color - 0.5) * uContrast + 0.5, 0.0, 1.0);

  float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
  color = clamp(mix(vec3(luma), color, uSaturation), 0.0, 1.0);

  if (uGamma != 1.0) {
    color = pow(color, vec3(1.0 / max(uGamma, 0.05)));
  }

  if (uVignette > 0.001) {
    vec2 d = vUv - 0.5;
    color *= 1.0 - uVignette * clamp(dot(d, d) * 2.4, 0.0, 1.0);
  }

  fragColor = vec4(color, 1.0);
}
`;

export class PostProcessor {
  private gl: WebGL2RenderingContext;
  private program: Program;
  private quad: FullscreenQuad;

  settings: PostSettings = { ...DEFAULT_POST };

  constructor(glctx: GLContext, quad: FullscreenQuad) {
    this.gl = glctx.gl;
    this.quad = quad;
    this.program = new Program(this.gl, {
      vertex: FULLSCREEN_VERT,
      fragment: POST_FRAGMENT,
    });
  }

  setSettings(patch: Partial<PostSettings>): void {
    Object.assign(this.settings, patch);
  }

  /** Draw `scene` to the bound framebuffer with the current image settings. */
  render(scene: WebGLTexture, width: number, height: number, target: WebGLFramebuffer | null): void {
    const gl = this.gl;
    const s = this.settings;

    gl.bindFramebuffer(gl.FRAMEBUFFER, target);
    gl.viewport(0, 0, width, height);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);

    this.program
      .use()
      .texture('uScene', scene)
      .float('uBrightness', s.brightness)
      .float('uContrast', s.contrast)
      .float('uSaturation', s.saturation)
      .float('uGamma', s.gamma)
      .float('uVignette', s.vignette)
      .float('uToneMap', s.toneMap ? 1 : 0);

    this.quad.draw();
  }

  dispose(): void {
    this.program.dispose();
  }
}
