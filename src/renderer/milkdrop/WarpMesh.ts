import type { FrameState, PixelState, PresetRuntime } from './PresetRuntime';

/**
 * The warp mesh - MilkDrop's core motion primitive.
 *
 * Each frame the previous frame's image is re-drawn through a deformed grid.
 * Every grid vertex gets a texture coordinate computed by the preset's
 * per-pixel equations plus MilkDrop's fixed zoom/rotate/stretch/translate/warp
 * transform, and the GPU interpolates between them. That interpolation is why
 * MilkDrop's motion looks fluid rather than blocky: the mesh is coarse (48x36
 * by default) but the resampling is bilinear.
 *
 * The transform below reproduces MilkDrop 2's `milkdropfs.cpp` vertex maths,
 * including the four-octave sine warp and the radius-dependent zoom exponent.
 * Small deviations here show up as presets that drift, spin the wrong way, or
 * lose their centre, so the ordering of operations matters more than it looks.
 */

/** Floats per vertex: pos.xy, uv.xy, uvOrig.xy, rad, ang. */
export const FLOATS_PER_VERTEX = 8;

export class WarpMesh {
  private gl: WebGL2RenderingContext;
  private vao: WebGLVertexArrayObject;
  private vbo: WebGLBuffer;
  private ibo: WebGLBuffer;

  meshX: number;
  meshY: number;
  private vertexData: Float32Array;
  private indexCount = 0;

  /** Scratch object reused for every vertex, so the loop allocates nothing. */
  private pixelState: PixelState = {
    zoom: 1, zoomExp: 1, rot: 0, warp: 1, cx: 0.5, cy: 0.5, dx: 0, dy: 0, sx: 1, sy: 1,
  };

  constructor(gl: WebGL2RenderingContext, meshX: number, meshY: number) {
    this.gl = gl;
    this.meshX = Math.max(2, Math.min(meshX, 192));
    this.meshY = Math.max(2, Math.min(meshY, 144));

    const vao = gl.createVertexArray();
    const vbo = gl.createBuffer();
    const ibo = gl.createBuffer();
    if (!vao || !vbo || !ibo) throw new Error('Could not allocate warp mesh');
    this.vao = vao;
    this.vbo = vbo;
    this.ibo = ibo;

    this.vertexData = new Float32Array(0);
    this.rebuild(this.meshX, this.meshY);
  }

  /** (Re)allocate GPU buffers for a new grid resolution. */
  rebuild(meshX: number, meshY: number): void {
    const gl = this.gl;
    this.meshX = Math.max(2, Math.min(meshX, 192));
    this.meshY = Math.max(2, Math.min(meshY, 144));

    const cols = this.meshX + 1;
    const rows = this.meshY + 1;
    this.vertexData = new Float32Array(cols * rows * FLOATS_PER_VERTEX);

    // Two triangles per cell. The index buffer never changes, so it is uploaded
    // once here and only the vertex data is streamed each frame.
    const indices = new Uint32Array(this.meshX * this.meshY * 6);
    let k = 0;
    for (let j = 0; j < this.meshY; j++) {
      for (let i = 0; i < this.meshX; i++) {
        const a = j * cols + i;
        const b = a + 1;
        const c = a + cols;
        const d = c + 1;
        indices[k++] = a; indices[k++] = c; indices[k++] = b;
        indices[k++] = b; indices[k++] = c; indices[k++] = d;
      }
    }
    this.indexCount = k;

    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.vertexData.byteLength, gl.DYNAMIC_DRAW);

    const stride = FLOATS_PER_VERTEX * 4;
    const attribs: Array<[number, number, number]> = [
      [0, 2, 0],  // aPos
      [1, 2, 8],  // aUv
      [2, 2, 16], // aUvOrig
      [3, 1, 24], // aRad
      [4, 1, 28], // aAng
    ];
    for (const [location, size, offset] of attribs) {
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset);
    }

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
  }

  /**
   * Recompute every vertex for this frame and upload it.
   *
   * @param runtime   preset runtime, for per-pixel equations
   * @param state     results of this frame's per-frame equations
   * @param time      seconds, for the animated warp
   * @param aspectX/Y MilkDrop's aspect correction factors
   */
  update(
    runtime: PresetRuntime | null,
    state: FrameState,
    time: number,
    aspectX: number,
    aspectY: number,
  ): void {
    const cols = this.meshX + 1;
    const rows = this.meshY + 1;
    const data = this.vertexData;
    const usePerPixel = runtime?.hasPerPixel ?? false;
    const pixel = this.pixelState;

    /*
     * The animated warp uses four slowly-drifting spatial frequencies. These
     * magic constants are MilkDrop's; they are what gives the warp its
     * characteristic organic wobble rather than a regular ripple.
     */
    const warpTime = time * state.warpSpeed;
    const warpScaleInv = 1 / Math.max(state.warpScale, 1e-4);
    const f0 = 11.68 + 4 * Math.cos(warpTime * 1.413 + 10);
    const f1 = 8.77 + 3 * Math.cos(warpTime * 1.113 + 7);
    const f2 = 10.54 + 3 * Math.cos(warpTime * 1.233 + 3);
    const f3 = 11.49 + 4 * Math.cos(warpTime * 0.933 + 5);

    let offset = 0;

    for (let j = 0; j < rows; j++) {
      // v runs 0 at the bottom so that y matches MilkDrop's convention and the
      // texture coordinate system lines up with GL's origin-at-bottom.
      const v = j / this.meshY;
      for (let i = 0; i < cols; i++) {
        const u = i / this.meshX;

        // Clip-space position, and the centred coordinates the maths works in.
        const px = u * 2 - 1;
        const py = v * 2 - 1;

        const ax = px * aspectX;
        const ay = py * aspectY;
        const rad = Math.sqrt(ax * ax + ay * ay);
        // MilkDrop measures the angle from +Y, and presets assume that origin.
        let ang = Math.atan2(ay, ax);
        if (ang < 0) ang += Math.PI * 2;

        let zoom = state.zoom;
        let zoomExp = state.zoomExp;
        let rot = state.rot;
        let warp = state.warp;
        let cx = state.cx;
        let cy = state.cy;
        let dx = state.dx;
        let dy = state.dy;
        let sx = state.sx;
        let sy = state.sy;

        if (usePerPixel && runtime) {
          runtime.runPixel(u, v, rad, ang, pixel);
          zoom = pixel.zoom;
          zoomExp = pixel.zoomExp;
          rot = pixel.rot;
          warp = pixel.warp;
          cx = pixel.cx;
          cy = pixel.cy;
          dx = pixel.dx;
          dy = pixel.dy;
          sx = pixel.sx;
          sy = pixel.sy;
        }

        /* --- MilkDrop's UV transform, in its original order --------------- */

        // Zoom, with the exponent making the effect radius-dependent. This is
        // what produces tunnels that accelerate toward the edges.
        const zoomExpSafe = zoomExp > 0 ? zoomExp : 1;
        const zoom2 = Math.pow(zoom > 0 ? zoom : 1e-4, Math.pow(zoomExpSafe, rad * 2 - 1));
        const zoomInv = 1 / (zoom2 || 1);

        let tu = px * 0.5 * aspectX * zoomInv + 0.5;
        let tv = py * 0.5 * aspectY * zoomInv + 0.5;

        // Stretch about the preset's centre.
        tu = (tu - cx) / (sx || 1e-4) + cx;
        tv = (tv - cy) / (sy || 1e-4) + cy;

        // Four-octave sine warp.
        if (warp !== 0) {
          const w = warp * 0.0035;
          tu += w * Math.sin(warpTime * 0.333 + warpScaleInv * (px * f0 - py * f3));
          tv += w * Math.cos(warpTime * 0.375 - warpScaleInv * (px * f2 + py * f1));
          tu += w * Math.cos(warpTime * 0.753 - warpScaleInv * (px * f1 - py * f2));
          tv += w * Math.sin(warpTime * 0.825 + warpScaleInv * (px * f0 + py * f3));
        }

        // Rotate about the centre.
        if (rot !== 0) {
          const cosR = Math.cos(rot);
          const sinR = Math.sin(rot);
          const ru = tu - cx;
          const rv = tv - cy;
          tu = ru * cosR - rv * sinR + cx;
          tv = ru * sinR + rv * cosR + cy;
        }

        // Translate last, so dx/dy are in final texture space.
        tu -= dx;
        tv -= dy;

        data[offset] = px;
        data[offset + 1] = py;
        data[offset + 2] = tu;
        data[offset + 3] = tv;
        data[offset + 4] = u;
        data[offset + 5] = v;
        data[offset + 6] = rad;
        data[offset + 7] = ang;
        offset += FLOATS_PER_VERTEX;
      }
    }

    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
  }

  draw(): void {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
  }

  dispose(): void {
    this.gl.deleteVertexArray(this.vao);
    this.gl.deleteBuffer(this.vbo);
    this.gl.deleteBuffer(this.ibo);
  }
}

export const WARP_VERTEX_SHADER = `#version 300 es
layout(location = 0) in vec2 aPos;
layout(location = 1) in vec2 aUv;
layout(location = 2) in vec2 aUvOrig;
layout(location = 3) in float aRad;
layout(location = 4) in float aAng;

out vec2 vUv;
out vec2 vUvOrig;
out vec4 vColor;
out float vRad;
out float vAng;

void main() {
  vUv = aUv;
  vUvOrig = aUvOrig;
  vRad = aRad;
  vAng = aAng;
  vColor = vec4(1.0);
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

/**
 * Composite pass vertex shader. A fullscreen triangle rather than a mesh -
 * the composite is a straight per-pixel operation, so the grid buys nothing.
 */
export const COMP_VERTEX_SHADER = `#version 300 es
layout(location = 0) in vec2 aPosition;

uniform vec4 aspect;

out vec2 vUv;
out vec2 vUvOrig;
out vec4 vColor;
out float vRad;
out float vAng;

void main() {
  vUv = aPosition * 0.5 + 0.5;
  vUvOrig = vUv;
  vec2 d = vec2(aPosition.x * aspect.x, aPosition.y * aspect.y);
  vRad = length(d);
  vAng = atan(d.y, d.x);
  vColor = vec4(1.0);
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;
