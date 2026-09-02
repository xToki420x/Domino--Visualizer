import type { GLContext } from './GLContext';

export interface FramebufferOptions {
  width: number;
  height: number;
  /** Use a float/half-float target so values can exceed 0..1. */
  hdr?: boolean;
  filter?: 'nearest' | 'linear';
  wrap?: 'clamp' | 'repeat' | 'mirror';
  mipmap?: boolean;
}

/** A single off-screen render target: one colour texture, no depth. */
export class Framebuffer {
  readonly glctx: GLContext;
  private gl: WebGL2RenderingContext;
  fbo: WebGLFramebuffer;
  texture: WebGLTexture;
  width: number;
  height: number;
  readonly options: Required<FramebufferOptions>;

  constructor(glctx: GLContext, options: FramebufferOptions) {
    this.glctx = glctx;
    this.gl = glctx.gl;
    this.options = {
      hdr: false,
      filter: 'linear',
      wrap: 'clamp',
      mipmap: false,
      ...options,
    };
    this.width = Math.max(1, Math.floor(options.width));
    this.height = Math.max(1, Math.floor(options.height));

    const gl = this.gl;
    const tex = gl.createTexture();
    const fbo = gl.createFramebuffer();
    if (!tex || !fbo) throw new Error('Could not allocate framebuffer');
    this.texture = tex;
    this.fbo = fbo;

    this.allocate();
  }

  private wrapMode(): number {
    const gl = this.gl;
    switch (this.options.wrap) {
      case 'repeat':
        return gl.REPEAT;
      case 'mirror':
        return gl.MIRRORED_REPEAT;
      default:
        return gl.CLAMP_TO_EDGE;
    }
  }

  private allocate(): void {
    const gl = this.gl;
    const fmt = this.options.hdr
      ? this.glctx.bestFloatFormat()
      : { internalFormat: gl.RGBA8, type: gl.UNSIGNED_BYTE, hdr: false };

    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      fmt.internalFormat,
      this.width,
      this.height,
      0,
      gl.RGBA,
      fmt.type,
      null,
    );

    const filter = this.options.filter === 'nearest' ? gl.NEAREST : gl.LINEAR;
    const minFilter =
      this.options.mipmap && this.options.filter !== 'nearest' ? gl.LINEAR_MIPMAP_LINEAR : filter;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, minFilter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, this.wrapMode());
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, this.wrapMode());

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texture, 0);

    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      throw new Error(`Framebuffer incomplete (0x${status.toString(16)})`);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  resize(width: number, height: number): void {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.allocate();
  }

  bind(): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.width, this.height);
  }

  clear(r = 0, g = 0, b = 0, a = 1): void {
    const gl = this.gl;
    this.bind();
    gl.clearColor(r, g, b, a);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  generateMipmap(): void {
    if (!this.options.mipmap) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.generateMipmap(gl.TEXTURE_2D);
  }

  dispose(): void {
    this.gl.deleteFramebuffer(this.fbo);
    this.gl.deleteTexture(this.texture);
  }
}

/**
 * Double-buffered target for feedback effects.
 *
 * `read()` is last frame's result, `write()` is where this frame goes. A shader
 * cannot sample the texture it is rendering into, so anything that feeds back
 * on itself - MilkDrop's warp, Shadertoy buffers, trails - needs this.
 */
export class PingPongTarget {
  private buffers: [Framebuffer, Framebuffer];
  private index = 0;

  constructor(glctx: GLContext, options: FramebufferOptions) {
    this.buffers = [new Framebuffer(glctx, options), new Framebuffer(glctx, options)];
  }

  read(): Framebuffer {
    return this.buffers[this.index];
  }
  write(): Framebuffer {
    return this.buffers[this.index ^ 1];
  }
  swap(): void {
    this.index ^= 1;
  }

  get width(): number {
    return this.buffers[0].width;
  }
  get height(): number {
    return this.buffers[0].height;
  }

  resize(width: number, height: number): void {
    this.buffers[0].resize(width, height);
    this.buffers[1].resize(width, height);
  }

  /** Clears both faces - use when starting fresh, so no stale frame leaks in. */
  clearBoth(r = 0, g = 0, b = 0, a = 1): void {
    this.buffers[0].clear(r, g, b, a);
    this.buffers[1].clear(r, g, b, a);
  }

  dispose(): void {
    this.buffers[0].dispose();
    this.buffers[1].dispose();
  }
}
