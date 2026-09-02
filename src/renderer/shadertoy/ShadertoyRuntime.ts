import type { GLContext } from '../gl/GLContext';
import { Program, ShaderCompileError, type ShaderError } from '../gl/Program';
import { FullscreenQuad, FULLSCREEN_VERT } from '../gl/Quad';
import { PingPongTarget } from '../gl/Framebuffer';
import { buildFragmentShader } from './preamble';
import type { AudioFrame } from '../audio/types';

export type BufferId = 'A' | 'B' | 'C' | 'D';
export type PassId = 'Image' | BufferId;

export const BUFFER_IDS: BufferId[] = ['A', 'B', 'C', 'D'];

export type ChannelSource =
  | { type: 'none' }
  | { type: 'audio' }
  | { type: 'buffer'; buffer: BufferId }
  | { type: 'noise' };

export interface PassDef {
  id: PassId;
  source: string;
  channels: ChannelSource[];
}

export interface ShadertoyProject {
  name: string;
  passes: PassDef[];
}

export interface CompileDiagnostics {
  ok: boolean;
  /** Errors keyed by pass id. Empty when everything compiled. */
  errorsByPass: Map<PassId, ShaderError[]>;
  message?: string;
}

interface CompiledPass {
  id: PassId;
  program: Program;
  channels: ChannelSource[];
}

/** Order matters: buffers feed the image, so they render first. */
const RENDER_ORDER: PassId[] = ['A', 'B', 'C', 'D', 'Image'];

export interface RenderContext {
  audio: AudioFrame;
  audioTexture: WebGLTexture;
  mouse: { x: number; y: number; clickX: number; clickY: number; down: boolean };
  sensitivity: number;
  sampleRate: number;
  fps: number;
}

/**
 * Executes a Shadertoy-style project: up to four feedback buffers plus an image
 * pass, wired together through iChannel bindings.
 *
 * Compilation is transactional. `compile()` builds every pass into fresh
 * programs and only swaps them in once all of them succeed, so a typo in the
 * editor leaves the previously working shader on screen instead of a black
 * frame. That is the single most important property for live coding.
 */
export class ShadertoyRuntime {
  private glctx: GLContext;
  private gl: WebGL2RenderingContext;
  private quad: FullscreenQuad;

  private passes: CompiledPass[] = [];
  private buffers = new Map<BufferId, PingPongTarget>();
  private noiseTexture: WebGLTexture | null = null;

  private frameIndex = 0;
  private startTime = performance.now() / 1000;
  private lastTime = this.startTime;
  private width = 1;
  private height = 1;

  project: ShadertoyProject | null = null;

  constructor(glctx: GLContext) {
    this.glctx = glctx;
    this.gl = glctx.gl;
    this.quad = new FullscreenQuad(this.gl);
  }

  /**
   * Compile a project. On failure the previous project keeps rendering and the
   * diagnostics describe what went wrong, per pass, in user line numbers.
   */
  compile(project: ShadertoyProject): CompileDiagnostics {
    const errorsByPass = new Map<PassId, ShaderError[]>();
    const built: CompiledPass[] = [];

    for (const passDef of project.passes) {
      const fragment = buildFragmentShader(passDef.source);
      try {
        const program = new Program(this.gl, {
          vertex: FULLSCREEN_VERT,
          fragment: fragment.source,
          fragmentPrologueLines: fragment.prologueLines,
          fragmentUserSource: passDef.source,
        });
        built.push({
          id: passDef.id,
          program,
          channels: normalizeChannels(passDef.channels),
        });
      } catch (err) {
        if (err instanceof ShaderCompileError) {
          errorsByPass.set(passDef.id, err.errors);
        } else {
          errorsByPass.set(passDef.id, [
            { line: 1, column: 0, message: err instanceof Error ? err.message : String(err) },
          ]);
        }
      }
    }

    if (errorsByPass.size > 0) {
      // Roll back: throw away the partial build so nothing leaks.
      for (const pass of built) pass.program.dispose();
      const first = [...errorsByPass.entries()][0];
      return {
        ok: false,
        errorsByPass,
        message: `${first[0]}: line ${first[1][0]?.line ?? 1} - ${first[1][0]?.message ?? 'failed'}`,
      };
    }

    // Swap in only now that every pass is known good.
    for (const pass of this.passes) pass.program.dispose();
    this.passes = built;
    this.project = project;
    this.ensureBuffers();
    return { ok: true, errorsByPass };
  }

  /** Allocate a ping-pong target for each buffer pass the project defines. */
  private ensureBuffers(): void {
    const needed = new Set<BufferId>();
    for (const pass of this.passes) {
      if (pass.id !== 'Image') needed.add(pass.id);
      // A pass may sample a buffer that has no pass of its own; that buffer
      // just stays black rather than being a compile error, matching Shadertoy.
      for (const channel of pass.channels) {
        if (channel.type === 'buffer') needed.add(channel.buffer);
      }
    }

    for (const id of needed) {
      if (this.buffers.has(id)) continue;
      this.buffers.set(
        id,
        new PingPongTarget(this.glctx, {
          width: this.width,
          height: this.height,
          hdr: true,
          filter: 'linear',
          wrap: 'clamp',
        }),
      );
    }

    for (const [id, target] of [...this.buffers]) {
      if (!needed.has(id)) {
        target.dispose();
        this.buffers.delete(id);
      }
    }
  }

  resize(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    for (const target of this.buffers.values()) target.resize(this.width, this.height);
  }

  /** Restart time and clear feedback state - the equivalent of Shadertoy's rewind. */
  reset(): void {
    this.frameIndex = 0;
    this.startTime = performance.now() / 1000;
    this.lastTime = this.startTime;
    for (const target of this.buffers.values()) target.clearBoth(0, 0, 0, 1);
  }

  private getNoiseTexture(): WebGLTexture {
    if (this.noiseTexture) return this.noiseTexture;
    const gl = this.gl;
    const size = 256;
    const data = new Uint8Array(size * size * 4);
    // Plain white noise, tiled. Cheap, and what most ported shaders expect from
    // a "noise" channel.
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 256) | 0;

    const tex = gl.createTexture();
    if (!tex) throw new Error('Could not create noise texture');
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.generateMipmap(gl.TEXTURE_2D);
    this.noiseTexture = tex;
    return tex;
  }

  private resolveChannel(channel: ChannelSource, ctx: RenderContext): WebGLTexture | null {
    switch (channel.type) {
      case 'audio':
        return ctx.audioTexture;
      case 'buffer': {
        // Read the *previous* contents; the pass writing this buffer is either
        // this one (feedback) or an earlier one this frame, and either way the
        // read face holds the right data.
        const target = this.buffers.get(channel.buffer);
        return target ? target.read().texture : null;
      }
      case 'noise':
        return this.getNoiseTexture();
      default:
        return null;
    }
  }

  private setUniforms(program: Program, ctx: RenderContext, width: number, height: number): void {
    const now = performance.now() / 1000;
    const time = now - this.startTime;
    const dt = Math.min(Math.max(now - this.lastTime, 1 / 1000), 0.25);

    program.vec3('iResolution', width, height, 1);
    program.float('iTime', time);
    program.float('iTimeDelta', dt);
    program.float('iFrameRate', ctx.fps);
    program.int('iFrame', this.frameIndex);
    program.float('iSampleRate', ctx.sampleRate);
    program.vec4(
      'iMouse',
      ctx.mouse.x,
      ctx.mouse.y,
      ctx.mouse.down ? ctx.mouse.clickX : -Math.abs(ctx.mouse.clickX),
      ctx.mouse.down ? ctx.mouse.clickY : -Math.abs(ctx.mouse.clickY),
    );

    const d = new Date();
    program.vec4(
      'iDate',
      d.getFullYear(),
      d.getMonth(),
      d.getDate(),
      d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds() + d.getMilliseconds() / 1000,
    );

    program.floatArray('iChannelTime', new Float32Array([time, time, time, time]));

    const a = ctx.audio;
    program.float('iBass', a.bass);
    program.float('iMid', a.mid);
    program.float('iTreb', a.treb);
    program.float('iBassAtt', a.bassAtt);
    program.float('iMidAtt', a.midAtt);
    program.float('iTrebAtt', a.trebAtt);
    program.float('iVolume', a.vol);
    program.float('iVolumeAtt', a.volAtt);
    program.float('iBeat', a.beat ? 1 : 0);
    program.float('iBeatPulse', a.beatPulse);
    program.float('iBPM', a.bpm);
    program.float('iRMS', a.rms);
    program.float('iPeak', a.peak);
    program.float('iSensitivity', ctx.sensitivity);
    program.float('iAudioLevel', a.vol);
  }

  /**
   * Render one frame. `targetFbo` is null for the default framebuffer.
   * Returns the texture holding the final image when rendering off-screen.
   */
  render(ctx: RenderContext, targetFbo: WebGLFramebuffer | null): void {
    if (this.passes.length === 0) return;
    const gl = this.gl;

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);

    const byId = new Map<PassId, CompiledPass>();
    for (const pass of this.passes) byId.set(pass.id, pass);

    for (const passId of RENDER_ORDER) {
      const pass = byId.get(passId);
      if (!pass) continue;

      const isImage = passId === 'Image';
      const target = isImage ? null : this.buffers.get(passId as BufferId);

      let width = this.width;
      let height = this.height;

      if (isImage) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, targetFbo);
        gl.viewport(0, 0, this.width, this.height);
      } else if (target) {
        target.write().bind();
        width = target.width;
        height = target.height;
      } else {
        continue;
      }

      const program = pass.program.use();
      this.setUniforms(program, ctx, width, height);

      const channelRes = new Float32Array(12);
      for (let i = 0; i < 4; i++) {
        const channel = pass.channels[i] ?? { type: 'none' };
        const tex = this.resolveChannel(channel, ctx);
        program.texture(`iChannel${i}`, tex);
        if (channel.type === 'audio') {
          channelRes[i * 3] = 512;
          channelRes[i * 3 + 1] = 2;
        } else if (channel.type === 'buffer') {
          channelRes[i * 3] = width;
          channelRes[i * 3 + 1] = height;
        } else if (channel.type === 'noise') {
          channelRes[i * 3] = 256;
          channelRes[i * 3 + 1] = 256;
        }
        channelRes[i * 3 + 2] = 1;
      }
      // Legacy alias so older shaders that sample iAudioData still work even
      // when they never bind a channel.
      program.texture('iAudioData', ctx.audioTexture);
      // iChannelResolution is vec3[4], so this must go up as uniform3fv.
      program.vec3Array('iChannelResolution', channelRes);

      this.quad.draw();

      // Swap after drawing so the next pass (and next frame) reads what we just
      // wrote. Buffers that feed themselves rely on this ordering.
      if (target) target.swap();
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.frameIndex++;
    this.lastTime = performance.now() / 1000;
  }

  dispose(): void {
    for (const pass of this.passes) pass.program.dispose();
    this.passes = [];
    for (const target of this.buffers.values()) target.dispose();
    this.buffers.clear();
    if (this.noiseTexture) this.gl.deleteTexture(this.noiseTexture);
    this.quad.dispose();
  }
}

function normalizeChannels(channels: ChannelSource[] | undefined): ChannelSource[] {
  const out: ChannelSource[] = [];
  for (let i = 0; i < 4; i++) out.push(channels?.[i] ?? { type: 'none' });
  // Channel 0 defaults to audio: nearly every visualizer shader wants it, and a
  // silent default would make imported shaders look broken for no reason.
  if (out[0].type === 'none') out[0] = { type: 'audio' };
  return out;
}

/** A single-pass project, which is what most shaders in the library are. */
export function singlePassProject(name: string, source: string): ShadertoyProject {
  return {
    name,
    passes: [{ id: 'Image', source, channels: [{ type: 'audio' }] }],
  };
}
