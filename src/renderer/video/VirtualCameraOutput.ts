import { Framebuffer } from '../gl/Framebuffer';
import type { GLContext } from '../gl/GLContext';
import { Program } from '../gl/Program';
import { FULLSCREEN_VERT, type FullscreenQuad } from '../gl/Quad';

/**
 * Packs the rendered frame into NV12 on the GPU and reads it back without
 * stalling the render loop.
 *
 * Two problems shape this. First, a conferencing app wants NV12, and doing
 * RGBA to NV12 in JavaScript would be about two million operations a frame -
 * far too slow at 30fps beside everything else the visualiser is doing. So the
 * conversion happens in a fragment shader, and the framebuffer is laid out so
 * that a straight readPixels already produces bytes in NV12 order.
 *
 * Second, readPixels normally blocks until the GPU catches up, which would tie
 * the visualiser's frame rate to the camera's. Reads go through pixel buffer
 * objects with a fence instead, and the result is collected a frame or two
 * later, so the camera never stalls what is on screen.
 */

/*
 * Each output texel is four bytes of NV12, so the target is a quarter as wide
 * as the frame and half again as tall: width/4 by height*3/2 RGBA texels comes
 * to exactly width*height*3/2 bytes.
 */
const NV12_FRAGMENT = `#version 300 es
precision highp float;
precision highp int;

uniform sampler2D uScene;
uniform ivec2 uSize;      // luma dimensions of the frame
uniform int uTotalRows;   // uSize.y * 3 / 2

out vec4 fragColor;

/*
 * BT.601 with limited range, matching the MFNominalRange_16_235 the media
 * source declares. Full-range coefficients would make everything look washed
 * out in consumers that assume the studio range for camera input.
 */
float lumaOf(vec3 c) {
  return (16.0 + 65.481 * c.r + 128.553 * c.g + 24.966 * c.b) / 255.0;
}

vec2 chromaOf(vec3 c) {
  float u = 128.0 - 37.797 * c.r - 74.203 * c.g + 112.0 * c.b;
  float v = 128.0 + 112.0 * c.r - 93.786 * c.g - 18.214 * c.b;
  return vec2(u, v) / 255.0;
}

/** Fetch a pixel by top-down row, which is how NV12 is addressed. */
vec3 fetchTopDown(int x, int rowFromTop) {
  int cx = clamp(x, 0, uSize.x - 1);
  int cy = clamp(uSize.y - 1 - rowFromTop, 0, uSize.y - 1);
  return texelFetch(uScene, ivec2(cx, cy), 0).rgb;
}

/** Average the four pixels a chroma sample covers. */
vec2 chromaBlock(int block, int uvRow) {
  int x = block * 2;
  int y = uvRow * 2;
  vec3 sum = fetchTopDown(x, y) + fetchTopDown(x + 1, y) +
             fetchTopDown(x, y + 1) + fetchTopDown(x + 1, y + 1);
  return chromaOf(sum * 0.25);
}

void main() {
  ivec2 o = ivec2(gl_FragCoord.xy);

  // readPixels hands back rows bottom-up, while NV12 is top-down, so the
  // flip happens here rather than in a second copy on the CPU.
  int row = uTotalRows - 1 - o.y;

  if (row < uSize.y) {
    int x = o.x * 4;
    fragColor = vec4(
      lumaOf(fetchTopDown(x, row)),
      lumaOf(fetchTopDown(x + 1, row)),
      lumaOf(fetchTopDown(x + 2, row)),
      lumaOf(fetchTopDown(x + 3, row)));
  } else {
    int uvRow = row - uSize.y;
    vec2 a = chromaBlock(o.x * 2, uvRow);
    vec2 b = chromaBlock(o.x * 2 + 1, uvRow);
    fragColor = vec4(a.x, a.y, b.x, b.y);
  }
}
`;

interface PendingRead {
  buffer: WebGLBuffer;
  sync: WebGLSync;
}

export interface VirtualCameraOutputStatus {
  width: number;
  height: number;
  fps: number;
  framesSent: number;
  framesDropped: number;
}

export class VirtualCameraOutput {
  private gl: WebGL2RenderingContext;
  private quad: FullscreenQuad;
  private program: Program;
  private target: Framebuffer;
  /**
   * The graded image at camera resolution.
   *
   * The camera keeps its own size regardless of how big the window is, so the
   * post-processed frame is drawn here first rather than being scraped off the
   * screen - which would make the output change shape when the user resizes.
   */
  private source: Framebuffer;

  private width = 1280;
  private height = 720;
  private fps = 30;

  /** Buffers not currently in flight, reused so we never allocate per frame. */
  private freeBuffers: WebGLBuffer[] = [];
  private pending: PendingRead[] = [];
  private scratch: Uint8Array;

  private lastCaptureMs = 0;
  private framesSent = 0;
  private framesDropped = 0;

  constructor(glctx: GLContext, quad: FullscreenQuad, width = 1280, height = 720, fps = 30) {
    this.gl = glctx.gl;
    this.quad = quad;
    this.program = new Program(this.gl, { vertex: FULLSCREEN_VERT, fragment: NV12_FRAGMENT });

    this.width = this.evenClamp(width);
    this.height = this.evenClamp(height);
    this.fps = Math.max(1, Math.min(60, Math.round(fps)));

    this.target = new Framebuffer(glctx, {
      width: this.packedWidth(),
      height: this.packedHeight(),
      filter: 'nearest',
    });
    this.source = new Framebuffer(glctx, {
      width: this.width,
      height: this.height,
      filter: 'linear',
    });
    this.scratch = new Uint8Array(this.frameBytes());
  }

  /** NV12 needs even dimensions - the chroma plane is half resolution. */
  private evenClamp(v: number): number {
    return Math.max(2, Math.floor(v / 2) * 2);
  }

  private packedWidth(): number {
    // Four bytes per RGBA texel, and width is always a multiple of four for
    // the sizes offered in the UI.
    return Math.ceil(this.width / 4);
  }

  private packedHeight(): number {
    return (this.height * 3) / 2;
  }

  private frameBytes(): number {
    return (this.width * this.height * 3) / 2;
  }

  /** Draw the graded frame here before calling capture(). */
  get sourceFbo(): WebGLFramebuffer {
    return this.source.fbo;
  }

  get sourceTexture(): WebGLTexture {
    return this.source.texture;
  }

  getStatus(): VirtualCameraOutputStatus {
    return {
      width: this.width,
      height: this.height,
      fps: this.fps,
      framesSent: this.framesSent,
      framesDropped: this.framesDropped,
    };
  }

  setFormat(width: number, height: number, fps: number): boolean {
    const w = this.evenClamp(width);
    const h = this.evenClamp(height);
    const f = Math.max(1, Math.min(60, Math.round(fps)));
    if (w === this.width && h === this.height && f === this.fps) return false;

    this.width = w;
    this.height = h;
    this.fps = f;
    this.target.resize(this.packedWidth(), this.packedHeight());
    this.source.resize(this.width, this.height);
    this.scratch = new Uint8Array(this.frameBytes());
    this.discardPending();
    return true;
  }

  /** True when enough time has passed to owe the camera another frame. */
  shouldCapture(nowMs: number): boolean {
    return nowMs - this.lastCaptureMs >= 1000 / this.fps - 1;
  }

  /**
   * Convert the image in `sourceTexture` to NV12 and start reading it back.
   *
   * Call this after drawing the post-processed frame into `sourceFbo`, so the
   * camera shows what the viewer sees rather than the raw pass before grading.
   */
  capture(nowMs: number): void {
    const gl = this.gl;
    this.lastCaptureMs = nowMs;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.target.fbo);
    gl.viewport(0, 0, this.target.width, this.target.height);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);

    this.program
      .use()
      .texture('uScene', this.source.texture)
      .ivec2('uSize', this.width, this.height)
      .int('uTotalRows', this.packedHeight());

    this.quad.draw();

    this.startReadback();

    // Hand the viewport back the way we found it: whatever draws next assumes
    // it still covers the drawing buffer.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
  }

  private startReadback(): void {
    const gl = this.gl;

    // More than a couple of reads in flight means the consumer is not keeping
    // up; dropping the oldest is better than growing an unbounded backlog of
    // stale frames.
    if (this.pending.length >= 3) {
      const oldest = this.pending.shift();
      if (oldest) {
        gl.deleteSync(oldest.sync);
        this.freeBuffers.push(oldest.buffer);
        this.framesDropped++;
      }
    }

    const buffer = this.freeBuffers.pop() ?? gl.createBuffer();
    if (!buffer) return;

    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, this.frameBytes(), gl.STREAM_READ);
    gl.readPixels(
      0,
      0,
      this.target.width,
      this.target.height,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      0,
    );
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);

    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    if (!sync) {
      this.freeBuffers.push(buffer);
      return;
    }
    // Without this the fence can sit unsignalled indefinitely on some drivers,
    // because nothing has forced the queued commands to be submitted.
    gl.flush();
    this.pending.push({ buffer, sync });
  }

  /**
   * Collect one finished readback, if there is one.
   *
   * Returns a view into a reused buffer: copy it or hand it straight on, but
   * do not hold it across frames.
   */
  poll(): Uint8Array | null {
    const gl = this.gl;
    const head = this.pending[0];
    if (!head) return null;

    const status = gl.clientWaitSync(head.sync, 0, 0);
    if (status !== gl.ALREADY_SIGNALED && status !== gl.CONDITION_SATISFIED) {
      return null;
    }

    this.pending.shift();
    gl.deleteSync(head.sync);

    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, head.buffer);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.scratch);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    this.freeBuffers.push(head.buffer);

    this.framesSent++;
    return this.scratch;
  }

  private discardPending(): void {
    const gl = this.gl;
    for (const item of this.pending) {
      gl.deleteSync(item.sync);
      this.freeBuffers.push(item.buffer);
    }
    this.pending = [];
  }

  dispose(): void {
    const gl = this.gl;
    this.discardPending();
    for (const buffer of this.freeBuffers) gl.deleteBuffer(buffer);
    this.freeBuffers = [];
    this.target.dispose();
    this.source.dispose();
    this.program.dispose();
  }
}
