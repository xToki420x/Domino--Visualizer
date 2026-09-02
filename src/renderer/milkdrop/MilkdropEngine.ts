import type { GLContext } from '../gl/GLContext';
import { PingPongTarget } from '../gl/Framebuffer';
import { Program, ShaderCompileError } from '../gl/Program';
import { FullscreenQuad } from '../gl/Quad';
import type { AudioFrame } from '../audio/types';
import { BlurChain } from './BlurChain';
import {
  drawBorders,
  drawCustomShapes,
  drawCustomWaves,
  drawDarkenCenter,
  drawMotionVectors,
  drawWaveform,
  type DrawContext,
} from './Decorations';
import { GeometryBatch } from './GeometryBatch';
import type { MilkPreset } from './PresetModel';
import { PresetRuntime, type FrameInputs } from './PresetRuntime';
import {
  DEFAULT_COMP_HLSL,
  DEFAULT_WARP_HLSL,
  translateCompShader,
  translateWarpShader,
} from './hlsl/Translator';
import { COMP_VERTEX_SHADER, WARP_VERTEX_SHADER, WarpMesh } from './WarpMesh';

export interface MilkdropOptions {
  meshX: number;
  meshY: number;
  /** Seconds a preset crossfade takes. */
  blendSeconds: number;
}

export interface MilkdropRenderContext {
  audio: AudioFrame;
  time: number;
  fps: number;
  frame: number;
  width: number;
  height: number;
}

export interface PresetLoadResult {
  ok: boolean;
  /** Equation compile failures, per block. */
  equationErrors: string[];
  /** Shader translation/compile failures. */
  shaderErrors: string[];
  warnings: string[];
}

/** Everything belonging to one loaded preset. Two exist during a crossfade. */
class PresetInstance {
  readonly preset: MilkPreset;
  readonly runtime: PresetRuntime;
  readonly mesh: WarpMesh;
  readonly main: PingPongTarget;
  blur: BlurChain | null = null;

  warpProgram: Program | null = null;
  compProgram: Program | null = null;

  /** True when either shader samples a blur texture, so the chain is needed. */
  needsBlur = false;
  readonly shaderErrors: string[] = [];
  readonly warnings: string[] = [];

  private glctx: GLContext;
  private quad: FullscreenQuad;

  constructor(
    glctx: GLContext,
    quad: FullscreenQuad,
    preset: MilkPreset,
    options: MilkdropOptions,
    width: number,
    height: number,
  ) {
    this.glctx = glctx;
    this.quad = quad;
    this.preset = preset;
    this.runtime = new PresetRuntime(preset);
    this.mesh = new WarpMesh(glctx.gl, options.meshX, options.meshY);
    this.main = new PingPongTarget(glctx, {
      width,
      height,
      hdr: true,
      filter: 'linear',
      wrap: 'repeat',
    });
    this.main.clearBoth(0, 0, 0, 1);
    this.compileShaders();
  }

  private compileShaders(): void {
    const gl = this.glctx.gl;

    const warp = translateWarpShader(this.preset.warpShader);
    const comp = translateCompShader(this.preset.compShader);
    this.warnings.push(...warp.warnings, ...comp.warnings);
    this.needsBlur =
      warp.glsl.includes('sampler_blur') ||
      comp.glsl.includes('sampler_blur') ||
      warp.glsl.includes('GetBlur') ||
      comp.glsl.includes('GetBlur');

    this.warpProgram = this.buildProgram(
      gl,
      WARP_VERTEX_SHADER,
      warp.glsl,
      warp.prologueLines,
      this.preset.warpShader,
      'warp',
      () => translateWarpShader(DEFAULT_WARP_HLSL),
    );
    this.compProgram = this.buildProgram(
      gl,
      COMP_VERTEX_SHADER,
      comp.glsl,
      comp.prologueLines,
      this.preset.compShader,
      'comp',
      () => translateCompShader(DEFAULT_COMP_HLSL),
    );
  }

  /**
   * Compile a translated preset shader, falling back to the built-in default
   * when it fails.
   *
   * Real-world preset collections contain plenty of shaders that no longer
   * compile even in MilkDrop. Substituting the default keeps the preset
   * watchable - motion and waves still work - instead of showing a black
   * screen, and the error is reported to the UI either way.
   */
  private buildProgram(
    gl: WebGL2RenderingContext,
    vertex: string,
    fragment: string,
    prologueLines: number,
    userSource: string,
    label: string,
    fallback: () => { glsl: string; prologueLines: number },
  ): Program | null {
    try {
      return new Program(gl, {
        vertex,
        fragment,
        fragmentPrologueLines: prologueLines,
        fragmentUserSource: userSource,
      });
    } catch (err) {
      if (err instanceof ShaderCompileError) {
        const first = err.errors[0];
        this.shaderErrors.push(
          `${label} shader line ${first?.line ?? 1}: ${first?.message ?? 'failed to compile'}`,
        );
      } else {
        this.shaderErrors.push(`${label} shader: ${(err as Error).message}`);
      }
      try {
        const def = fallback();
        return new Program(gl, { vertex, fragment: def.glsl });
      } catch {
        return null;
      }
    }
  }

  ensureBlur(): BlurChain | null {
    if (!this.needsBlur) return null;
    if (!this.blur) this.blur = new BlurChain(this.glctx, this.quad);
    return this.blur;
  }

  resize(width: number, height: number): void {
    this.main.resize(width, height);
    this.blur?.resize(width, height);
  }

  dispose(): void {
    this.warpProgram?.dispose();
    this.compProgram?.dispose();
    this.mesh.dispose();
    this.main.dispose();
    this.blur?.dispose();
  }
}

/**
 * The MilkDrop renderer.
 *
 * Per frame, per preset:
 *   1. run per-frame equations
 *   2. run per-pixel equations across the warp mesh and rebuild its UVs
 *   3. draw the previous frame through the mesh with the warp shader
 *   4. draw waveform, custom waves, shapes, borders and motion vectors on top
 *   5. build the blur pyramid, if any shader needs it
 *   6. run the composite shader to the output
 *
 * When a new preset is loaded the outgoing one keeps rendering into its own
 * buffers and both composites are mixed, which is what makes transitions
 * dissolve rather than cut.
 */
export class MilkdropEngine {
  private glctx: GLContext;
  private gl: WebGL2RenderingContext;
  private quad: FullscreenQuad;
  private batch: GeometryBatch;

  private current: PresetInstance | null = null;
  private outgoing: PresetInstance | null = null;
  private blendStart = 0;
  private blendDuration = 0;

  private noiseLQ: WebGLTexture;
  private noiseMQ: WebGLTexture;
  private noiseHQ: WebGLTexture;
  private blackTexture: WebGLTexture;

  private width = 1;
  private height = 1;
  /** Internal render resolution; the composite scales it to the canvas. */
  private renderWidth = 1;
  private renderHeight = 1;

  private presetStartTime = 0;

  options: MilkdropOptions = { meshX: 48, meshY: 36, blendSeconds: 2.7 };

  constructor(glctx: GLContext, quad?: FullscreenQuad) {
    this.glctx = glctx;
    this.gl = glctx.gl;
    this.quad = quad ?? new FullscreenQuad(glctx.gl);
    this.batch = new GeometryBatch(glctx.gl);

    this.noiseLQ = createNoiseTexture(this.gl, 256, true);
    this.noiseMQ = createNoiseTexture(this.gl, 256, true);
    this.noiseHQ = createNoiseTexture(this.gl, 512, true);
    this.blackTexture = createSolidTexture(this.gl, 0, 0, 0, 255);
  }

  get activePreset(): MilkPreset | null {
    return this.current?.preset ?? null;
  }

  get isBlending(): boolean {
    return this.outgoing !== null;
  }

  /**
   * Load a preset. When `blend` is true the previous preset crossfades out
   * over `options.blendSeconds`.
   */
  loadPreset(preset: MilkPreset, time: number, blend = true): PresetLoadResult {
    const instance = new PresetInstance(
      this.glctx,
      this.quad,
      preset,
      this.options,
      this.renderWidth,
      this.renderHeight,
    );

    // Seed the new preset's buffer with the outgoing image so a preset whose
    // decay is near 1.0 doesn't start from black and pop.
    if (this.current) {
      this.outgoing?.dispose();
      this.outgoing = blend ? this.current : null;
      if (!blend) this.current.dispose();
      this.blendStart = time;
      this.blendDuration = blend ? Math.max(this.options.blendSeconds, 0) : 0;
    }

    this.current = instance;
    this.presetStartTime = time;

    return {
      ok: instance.shaderErrors.length === 0 && instance.runtime.errors.length === 0,
      equationErrors: instance.runtime.errors,
      shaderErrors: instance.shaderErrors,
      warnings: [...instance.warnings, ...preset.warnings],
    };
  }

  setMeshSize(meshX: number, meshY: number): void {
    this.options.meshX = meshX;
    this.options.meshY = meshY;
    this.current?.mesh.rebuild(meshX, meshY);
    this.outgoing?.mesh.rebuild(meshX, meshY);
  }

  resize(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    // MilkDrop's feedback buffers are traditionally lower resolution than the
    // display; keeping them at output resolution looks better on modern GPUs,
    // but cap them so 4K doesn't turn the warp mesh pass into the bottleneck.
    const maxDimension = 1920;
    const scale = Math.min(1, maxDimension / Math.max(this.width, this.height));
    this.renderWidth = Math.max(64, Math.floor(this.width * scale));
    this.renderHeight = Math.max(64, Math.floor(this.height * scale));

    this.current?.resize(this.renderWidth, this.renderHeight);
    this.outgoing?.resize(this.renderWidth, this.renderHeight);
  }

  /** Aspect factors MilkDrop applies so presets look right on wide displays. */
  private aspect(): { x: number; y: number } {
    const ratio = this.renderWidth / Math.max(this.renderHeight, 1);
    return ratio >= 1 ? { x: 1, y: 1 / ratio } : { x: ratio, y: 1 };
  }

  render(ctx: MilkdropRenderContext, targetFbo: WebGLFramebuffer | null): void {
    if (!this.current) return;
    const gl = this.gl;

    // Retire the outgoing preset once the crossfade completes.
    let blend = 1;
    if (this.outgoing) {
      const elapsed = ctx.time - this.blendStart;
      if (this.blendDuration <= 0 || elapsed >= this.blendDuration) {
        this.outgoing.dispose();
        this.outgoing = null;
      } else {
        blend = elapsed / this.blendDuration;
        // Smoothstep the mix so the transition eases in and out.
        blend = blend * blend * (3 - 2 * blend);
      }
    }

    if (this.outgoing) {
      this.renderInstance(this.outgoing, ctx);
    }
    this.renderInstance(this.current, ctx);

    gl.bindFramebuffer(gl.FRAMEBUFFER, targetFbo);
    gl.viewport(0, 0, this.width, this.height);
    gl.disable(gl.DEPTH_TEST);

    if (this.outgoing) {
      gl.disable(gl.BLEND);
      this.composite(this.outgoing, ctx, 1);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      this.composite(this.current, ctx, blend);
      gl.disable(gl.BLEND);
    } else {
      gl.disable(gl.BLEND);
      this.composite(this.current, ctx, 1);
    }
  }

  /** Steps 1-5: equations, warp, decorations, blur. */
  private renderInstance(instance: PresetInstance, ctx: MilkdropRenderContext): void {
    const gl = this.gl;
    const aspect = this.aspect();

    const inputs: FrameInputs = {
      time: ctx.time,
      fps: ctx.fps,
      frame: ctx.frame,
      progress: this.blendDuration > 0
        ? Math.min((ctx.time - this.presetStartTime) / 30, 1)
        : Math.min((ctx.time - this.presetStartTime) / 30, 1),
      meshX: instance.mesh.meshX,
      meshY: instance.mesh.meshY,
      aspectX: aspect.x,
      aspectY: aspect.y,
      pixelsX: this.renderWidth,
      pixelsY: this.renderHeight,
    };

    const state = instance.runtime.runFrame(ctx.audio, inputs);
    instance.mesh.update(instance.runtime, state, ctx.time, aspect.x, aspect.y);

    // --- warp pass ------------------------------------------------------
    const source = instance.main.read();
    const dest = instance.main.write();

    // Texture wrapping is a per-preset switch; without it, presets that rely on
    // tiling show smeared edges instead of a repeating field.
    gl.bindTexture(gl.TEXTURE_2D, source.texture);
    const wrapMode = state.texWrap ? gl.REPEAT : gl.CLAMP_TO_EDGE;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrapMode);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrapMode);

    dest.bind();
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    if (instance.warpProgram) {
      const program = instance.warpProgram.use();
      this.setCommonUniforms(program, instance, ctx, state, aspect, 1);
      instance.mesh.draw();
    }

    // --- decorations ----------------------------------------------------
    const drawCtx: DrawContext = {
      batch: this.batch,
      audio: ctx.audio,
      state,
      aspectX: aspect.x,
      aspectY: aspect.y,
      width: this.renderWidth,
      height: this.renderHeight,
    };

    drawMotionVectors(drawCtx);
    drawCustomShapes(drawCtx, instance.runtime, ctx.audio, inputs);
    drawCustomWaves(drawCtx, instance.runtime, ctx.audio, inputs);
    drawWaveform(drawCtx);
    drawBorders(drawCtx);
    drawDarkenCenter(drawCtx);

    gl.disable(gl.BLEND);
    instance.main.swap();

    // --- blur pyramid ---------------------------------------------------
    const blur = instance.ensureBlur();
    if (blur) {
      blur.resize(this.renderWidth, this.renderHeight);
      blur.render(instance.main.read().texture, [
        { min: state.blur1Min, max: state.blur1Max },
        { min: state.blur2Min, max: state.blur2Max },
        { min: state.blur3Min, max: state.blur3Max },
      ]);
    }
  }

  /** Step 6: run the preset's composite shader to the current framebuffer. */
  private composite(
    instance: PresetInstance,
    ctx: MilkdropRenderContext,
    alpha: number,
  ): void {
    if (!instance.compProgram) return;
    const aspect = this.aspect();
    const program = instance.compProgram.use();
    this.setCommonUniforms(program, instance, ctx, instance.runtime.state, aspect, alpha);
    this.quad.draw();
  }

  /**
   * Bind the full MilkDrop uniform and sampler set.
   *
   * Every uniform is set unconditionally: `Program` silently skips names the
   * shader didn't declare, so this costs a map lookup for unused ones and
   * removes any chance of a preset reading a stale value.
   */
  private setCommonUniforms(
    program: Program,
    instance: PresetInstance,
    ctx: MilkdropRenderContext,
    state: ReturnType<PresetRuntime['runFrame']>,
    aspect: { x: number; y: number },
    blendAlpha: number,
  ): void {
    const audio = ctx.audio;
    const w = this.renderWidth;
    const h = this.renderHeight;

    program.vec4('texsize', w, h, 1 / w, 1 / h);
    program.vec4('texsize_noise_lq', 256, 256, 1 / 256, 1 / 256);
    program.vec4('texsize_noise_mq', 256, 256, 1 / 256, 1 / 256);
    program.vec4('texsize_noise_hq', 512, 512, 1 / 512, 1 / 512);
    program.vec4('aspect', aspect.x, aspect.y, 1 / aspect.x, 1 / aspect.y);

    program.float('time', ctx.time);
    program.float('fps', ctx.fps);
    program.float('frame', ctx.frame);
    program.float('progress', Math.min((ctx.time - this.presetStartTime) / 30, 1));
    program.float('blend_alpha', blendAlpha);

    program.float('bass', audio.bass);
    program.float('mid', audio.mid);
    program.float('treb', audio.treb);
    program.float('bass_att', audio.bassAtt);
    program.float('mid_att', audio.midAtt);
    program.float('treb_att', audio.trebAtt);
    program.float('vol', audio.vol);
    program.float('vol_att', audio.volAtt);

    program.float('decay', state.decay);
    program.float('gammaAdj', state.gamma);
    program.float('echo_zoom', state.echoZoom);
    program.float('echo_alpha', state.echoAlpha);
    program.float('echo_orient', state.echoOrient);
    program.float('invert', state.invert ? 1 : 0);
    program.float('brighten', state.brighten ? 1 : 0);
    program.float('darken', state.darken ? 1 : 0);
    program.float('solarize', state.solarize ? 1 : 0);

    // Per-frame and per-preset randomness, as MilkDrop provides them.
    program.vec4('rand_frame', Math.random(), Math.random(), Math.random(), Math.random());
    program.vec4('rand_preset', 0.37, 0.62, 0.11, 0.84);

    // Roaming oscillators presets use for slow drift.
    const t = ctx.time;
    program.vec4(
      'roam_cos',
      Math.cos(t * 0.831),
      Math.cos(t * 0.663),
      Math.cos(t * 0.517),
      Math.cos(t * 0.397),
    );
    program.vec4(
      'roam_sin',
      Math.sin(t * 0.831),
      Math.sin(t * 0.663),
      Math.sin(t * 0.517),
      Math.sin(t * 0.397),
    );
    program.vec4(
      'slow_roam_cos',
      Math.cos(t * 0.05),
      Math.cos(t * 0.08),
      Math.cos(t * 0.13),
      Math.cos(t * 0.21),
    );
    program.vec4(
      'slow_roam_sin',
      Math.sin(t * 0.05),
      Math.sin(t * 0.08),
      Math.sin(t * 0.13),
      Math.sin(t * 0.21),
    );

    // q1..q32 packed into eight vec4s, matching MilkDrop's _qa.._qh.
    const q = state.q;
    const packs = ['_qa', '_qb', '_qc', '_qd', '_qe', '_qf', '_qg', '_qh'];
    for (let i = 0; i < 8; i++) {
      const base = i * 4 + 1;
      program.vec4(packs[i], q[base], q[base + 1], q[base + 2], q[base + 3]);
    }

    const blur = instance.blur;
    const levels = blur?.levels ?? [];
    program.float('scale1', levels[0]?.scale ?? 1);
    program.float('bias1', levels[0]?.bias ?? 0);
    program.float('scale2', levels[1]?.scale ?? 1);
    program.float('bias2', levels[1]?.bias ?? 0);
    program.float('scale3', levels[2]?.scale ?? 1);
    program.float('bias3', levels[2]?.bias ?? 0);

    // Samplers. Order here determines texture-unit assignment, which resets on
    // each use() call, so all binds for a program must happen together.
    const mainTexture = instance.main.read().texture;
    program.texture('sampler_main', mainTexture);
    program.texture('sampler_fc_main', mainTexture);
    program.texture('sampler_pc_main', mainTexture);
    program.texture('sampler_fw_main', mainTexture);
    program.texture('sampler_pw_main', mainTexture);
    program.texture('sampler_blur1', levels[0]?.target.texture ?? this.blackTexture);
    program.texture('sampler_blur2', levels[1]?.target.texture ?? this.blackTexture);
    program.texture('sampler_blur3', levels[2]?.target.texture ?? this.blackTexture);
    program.texture('sampler_noise_lq', this.noiseLQ);
    program.texture('sampler_noise_mq', this.noiseMQ);
    program.texture('sampler_noise_hq', this.noiseHQ);
    program.texture('sampler_pw_noise_lq', this.noiseLQ);
    program.texture('sampler_noisevol_lq', this.noiseLQ);
    program.texture('sampler_noisevol_hq', this.noiseHQ);
  }

  /** Diagnostics for the preset inspector. */
  getDiagnostics(): { equationErrors: string[]; shaderErrors: string[]; warnings: string[] } {
    return {
      equationErrors: this.current?.runtime.errors ?? [],
      shaderErrors: this.current?.shaderErrors ?? [],
      warnings: this.current?.warnings ?? [],
    };
  }

  dispose(): void {
    this.current?.dispose();
    this.outgoing?.dispose();
    this.current = null;
    this.outgoing = null;
    this.batch.dispose();
    this.gl.deleteTexture(this.noiseLQ);
    this.gl.deleteTexture(this.noiseMQ);
    this.gl.deleteTexture(this.noiseHQ);
    this.gl.deleteTexture(this.blackTexture);
  }
}

/* ------------------------------- textures ------------------------------- */

function createNoiseTexture(
  gl: WebGL2RenderingContext,
  size: number,
  smooth: boolean,
): WebGLTexture {
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 256) | 0;

  const tex = gl.createTexture();
  if (!tex) throw new Error('Could not create noise texture');
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  const filter = smooth ? gl.LINEAR : gl.NEAREST;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  // Noise is always tiled by presets, so repeat is the only useful wrap mode.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  return tex;
}

function createSolidTexture(
  gl: WebGL2RenderingContext,
  r: number,
  g: number,
  b: number,
  a: number,
): WebGLTexture {
  const tex = gl.createTexture();
  if (!tex) throw new Error('Could not create texture');
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(
    gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
    new Uint8Array([r, g, b, a]),
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}
