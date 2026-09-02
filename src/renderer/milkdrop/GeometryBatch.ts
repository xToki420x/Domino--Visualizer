import { Program } from '../gl/Program';

/**
 * Immediate-mode coloured geometry, used for everything MilkDrop draws on top
 * of the warped frame: the waveform, custom waves, custom shapes, borders,
 * motion vectors and the darkened centre.
 *
 * These are all small, per-frame, CPU-generated vertex sets. Streaming them
 * through one growable buffer with a handful of draw calls is both simpler and
 * faster than maintaining separate static buffers that would be invalidated
 * every frame anyway.
 *
 * Positions are in clip space (-1..1) and colours are straight RGBA.
 */

const VERTEX_SHADER = `#version 300 es
layout(location = 0) in vec2 aPos;
layout(location = 1) in vec4 aColor;
out vec4 vColor;
void main() {
  vColor = aColor;
  gl_Position = vec4(aPos, 0.0, 1.0);
  gl_PointSize = 1.0;
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec4 vColor;
out vec4 fragColor;
void main() {
  fragColor = vColor;
}
`;

/** pos.xy + rgba */
const FLOATS_PER_VERTEX = 6;

export type BlendMode = 'alpha' | 'additive' | 'none';

export class GeometryBatch {
  private gl: WebGL2RenderingContext;
  private program: Program;
  private vao: WebGLVertexArrayObject;
  private vbo: WebGLBuffer;

  private data: Float32Array;
  private count = 0;
  private capacityVertices: number;

  constructor(gl: WebGL2RenderingContext, initialVertices = 8192) {
    this.gl = gl;
    this.program = new Program(gl, { vertex: VERTEX_SHADER, fragment: FRAGMENT_SHADER });

    const vao = gl.createVertexArray();
    const vbo = gl.createBuffer();
    if (!vao || !vbo) throw new Error('Could not allocate geometry batch');
    this.vao = vao;
    this.vbo = vbo;

    this.capacityVertices = initialVertices;
    this.data = new Float32Array(this.capacityVertices * FLOATS_PER_VERTEX);

    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.STREAM_DRAW);
    const stride = FLOATS_PER_VERTEX * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 8);
    gl.bindVertexArray(null);
  }

  /** Start a new primitive batch. */
  begin(): void {
    this.count = 0;
  }

  private ensure(extraVertices: number): void {
    const needed = this.count + extraVertices;
    if (needed <= this.capacityVertices) return;
    let capacity = this.capacityVertices;
    while (capacity < needed) capacity *= 2;
    const grown = new Float32Array(capacity * FLOATS_PER_VERTEX);
    grown.set(this.data.subarray(0, this.count * FLOATS_PER_VERTEX));
    this.data = grown;
    this.capacityVertices = capacity;

    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.STREAM_DRAW);
    gl.bindVertexArray(null);
  }

  vertex(x: number, y: number, r: number, g: number, b: number, a: number): void {
    this.ensure(1);
    const offset = this.count * FLOATS_PER_VERTEX;
    const data = this.data;
    data[offset] = x;
    data[offset + 1] = y;
    data[offset + 2] = r;
    data[offset + 3] = g;
    data[offset + 4] = b;
    data[offset + 5] = a;
    this.count++;
  }

  /**
   * Add a thick line segment as two triangles.
   *
   * WebGL's `lineWidth` is capped at 1.0 on essentially every desktop driver,
   * so MilkDrop's thick waves have to be built from quads to be visible.
   */
  thickSegment(
    x0: number, y0: number, x1: number, y1: number,
    r: number, g: number, b: number, a: number,
    width: number,
  ): void {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const length = Math.hypot(dx, dy);
    if (length < 1e-8) return;
    // Perpendicular, scaled to half the requested width.
    const nx = (-dy / length) * width * 0.5;
    const ny = (dx / length) * width * 0.5;

    this.vertex(x0 - nx, y0 - ny, r, g, b, a);
    this.vertex(x0 + nx, y0 + ny, r, g, b, a);
    this.vertex(x1 - nx, y1 - ny, r, g, b, a);

    this.vertex(x1 - nx, y1 - ny, r, g, b, a);
    this.vertex(x0 + nx, y0 + ny, r, g, b, a);
    this.vertex(x1 + nx, y1 + ny, r, g, b, a);
  }

  get vertexCount(): number {
    return this.count;
  }

  private applyBlend(mode: BlendMode): void {
    const gl = this.gl;
    if (mode === 'none') {
      gl.disable(gl.BLEND);
      return;
    }
    gl.enable(gl.BLEND);
    if (mode === 'additive') {
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    } else {
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    }
  }

  /** Upload and draw whatever has been accumulated. */
  flush(mode: 'triangles' | 'lines' | 'linestrip' | 'points', blend: BlendMode = 'alpha'): void {
    if (this.count === 0) return;
    const gl = this.gl;

    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.data.subarray(0, this.count * FLOATS_PER_VERTEX));

    this.program.use();
    this.applyBlend(blend);
    gl.disable(gl.DEPTH_TEST);

    const glMode =
      mode === 'triangles'
        ? gl.TRIANGLES
        : mode === 'lines'
          ? gl.LINES
          : mode === 'linestrip'
            ? gl.LINE_STRIP
            : gl.POINTS;

    gl.drawArrays(glMode, 0, this.count);
    gl.bindVertexArray(null);
    this.count = 0;
  }

  dispose(): void {
    this.gl.deleteVertexArray(this.vao);
    this.gl.deleteBuffer(this.vbo);
    this.program.dispose();
  }
}
