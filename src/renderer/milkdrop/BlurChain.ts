import type { GLContext } from '../gl/GLContext';
import { Framebuffer } from '../gl/Framebuffer';
import { Program } from '../gl/Program';
import { FullscreenQuad, FULLSCREEN_VERT } from '../gl/Quad';

/**
 * The three-level blur pyramid MilkDrop 2 presets sample through
 * GetBlur1/2/3.
 *
 * Each level is half the resolution of the one above and gets a separable
 * Gaussian, so level 3 has an effective radius of tens of pixels for the cost
 * of a few small passes. Presets use these for bloom, glow and edge detection,
 * and a preset that samples an unpopulated blur texture renders black - so the
 * chain is always produced when any shader references it.
 *
 * MilkDrop stores blur results scaled into 0..1 and hands shaders a
 * scale/bias pair to undo it. We keep the same convention because preset
 * shaders apply that decode themselves via GetBlurN().
 */

const BLUR_FRAGMENT = `#version 300 es
precision highp float;

uniform sampler2D uSource;
uniform vec2 uTexelStep;
uniform float uScale;

in vec2 vUv;
out vec4 fragColor;

void main() {
  // Nine-tap Gaussian, weights from the binomial row 1 8 28 56 70 56 28 8 1
  // normalised. Sampling on the diagonal of the step vector lets one shader
  // serve both the horizontal and vertical passes.
  float w0 = 0.2734375;
  float w1 = 0.21875;
  float w2 = 0.109375;
  float w3 = 0.03125;
  float w4 = 0.00390625;

  vec3 sum = texture(uSource, vUv).rgb * w0;
  sum += texture(uSource, vUv + uTexelStep).rgb * w1;
  sum += texture(uSource, vUv - uTexelStep).rgb * w1;
  sum += texture(uSource, vUv + uTexelStep * 2.0).rgb * w2;
  sum += texture(uSource, vUv - uTexelStep * 2.0).rgb * w2;
  sum += texture(uSource, vUv + uTexelStep * 3.0).rgb * w3;
  sum += texture(uSource, vUv - uTexelStep * 3.0).rgb * w3;
  sum += texture(uSource, vUv + uTexelStep * 4.0).rgb * w4;
  sum += texture(uSource, vUv - uTexelStep * 4.0).rgb * w4;

  fragColor = vec4(sum * uScale, 1.0);
}
`;

export interface BlurLevel {
  /** Result of the vertical (second) pass - what shaders sample. */
  target: Framebuffer;
  /** Intermediate holding the horizontal pass. */
  scratch: Framebuffer;
  scale: number;
  bias: number;
}

export class BlurChain {
  private glctx: GLContext;
  private gl: WebGL2RenderingContext;
  private program: Program;
  private quad: FullscreenQuad;
  levels: BlurLevel[] = [];

  private width = 0;
  private height = 0;

  constructor(glctx: GLContext, quad: FullscreenQuad) {
    this.glctx = glctx;
    this.gl = glctx.gl;
    this.quad = quad;
    this.program = new Program(this.gl, {
      vertex: FULLSCREEN_VERT,
      fragment: BLUR_FRAGMENT,
    });
  }

  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;

    for (const level of this.levels) {
      level.target.dispose();
      level.scratch.dispose();
    }
    this.levels = [];

    let w = width;
    let h = height;
    for (let i = 0; i < 3; i++) {
      w = Math.max(4, Math.floor(w / 2));
      h = Math.max(4, Math.floor(h / 2));
      const options = { width: w, height: h, hdr: true, filter: 'linear' as const };
      this.levels.push({
        target: new Framebuffer(this.glctx, options),
        scratch: new Framebuffer(this.glctx, options),
        scale: 1,
        bias: 0,
      });
    }
  }

  /**
   * Build all three levels from `source`.
   *
   * The min/max pairs come from the preset's b1n/b1x style variables and
   * describe the value range the preset expects back out of the blur, which we
   * turn into the scale/bias the shader uses to decode.
   */
  render(
    source: WebGLTexture,
    ranges: Array<{ min: number; max: number }>,
  ): void {
    const gl = this.gl;
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);

    let input = source;

    for (let i = 0; i < this.levels.length; i++) {
      const level = this.levels[i];

      // Horizontal pass.
      level.scratch.bind();
      this.program
        .use()
        .texture('uSource', input)
        .vec2('uTexelStep', 1 / level.scratch.width, 0)
        .float('uScale', 1);
      this.quad.draw();

      // Vertical pass.
      level.target.bind();
      this.program
        .use()
        .texture('uSource', level.scratch.texture)
        .vec2('uTexelStep', 0, 1 / level.target.height)
        .float('uScale', 1);
      this.quad.draw();

      // Each level feeds the next, which is what makes the radius grow
      // geometrically for a linear amount of work.
      input = level.target.texture;

      const range = ranges[i] ?? { min: 0, max: 1 };
      const min = Math.min(range.min, range.max);
      const max = Math.max(range.min, range.max);
      const spread = max - min;
      level.scale = spread > 1e-5 ? spread : 1;
      level.bias = min;
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  dispose(): void {
    for (const level of this.levels) {
      level.target.dispose();
      level.scratch.dispose();
    }
    this.levels = [];
    this.program.dispose();
  }
}
