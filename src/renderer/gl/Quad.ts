/**
 * Fullscreen triangle.
 *
 * A single oversized triangle rather than two triangles: it covers the viewport
 * with one primitive, avoids the diagonal seam where quantised interpolation can
 * differ across the shared edge, and skips redundant fragment work along it.
 */
export class FullscreenQuad {
  private gl: WebGL2RenderingContext;
  private vao: WebGLVertexArrayObject;
  private vbo: WebGLBuffer;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;

    const vao = gl.createVertexArray();
    const vbo = gl.createBuffer();
    if (!vao || !vbo) throw new Error('Could not create fullscreen quad');
    this.vao = vao;
    this.vbo = vbo;

    // Clip-space positions covering [-1,1] twice over; the parts outside the
    // viewport are clipped away for free.
    const verts = new Float32Array([-1, -1, 3, -1, -1, 3]);

    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  draw(): void {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  dispose(): void {
    this.gl.deleteVertexArray(this.vao);
    this.gl.deleteBuffer(this.vbo);
  }
}

/** Vertex shader for anything drawn with FullscreenQuad. */
export const FULLSCREEN_VERT = `#version 300 es
layout(location = 0) in vec2 aPosition;
out vec2 vUv;
void main() {
  vUv = aPosition * 0.5 + 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;
