/**
 * Shader program compilation with editor-grade error reporting.
 *
 * Because users edit shaders live, a failed compile has to explain itself in
 * terms of *their* source, not the concatenated string we actually handed to
 * the driver. `prologueLines` records how much boilerplate we prepended so
 * reported line numbers can be shifted back into user space.
 */

export interface ShaderError {
  line: number;
  column: number;
  message: string;
  /** The offending source line, when we can recover it. */
  source?: string;
}

export class ShaderCompileError extends Error {
  readonly errors: ShaderError[];
  readonly stage: 'vertex' | 'fragment' | 'link';
  readonly rawLog: string;

  constructor(stage: 'vertex' | 'fragment' | 'link', errors: ShaderError[], rawLog: string) {
    const head = errors[0];
    super(head ? `${stage} shader line ${head.line}: ${head.message}` : `${stage} shader failed`);
    this.name = 'ShaderCompileError';
    this.stage = stage;
    this.errors = errors;
    this.rawLog = rawLog;
  }
}

/**
 * Parse a driver info log into structured errors.
 *
 * Every desktop GL driver emits some variation of
 * `ERROR: 0:12: 'foo' : undeclared identifier`, so that is the shape we target,
 * with a loose fallback for drivers that don't cooperate.
 */
function parseInfoLog(log: string, prologueLines: number, userSource: string): ShaderError[] {
  const lines = userSource.split('\n');
  const out: ShaderError[] = [];
  const pattern = /^(?:ERROR|WARNING):\s*(\d+):(\d+):\s*(.*)$/;

  for (const raw of log.split('\n')) {
    const text = raw.trim();
    if (!text) continue;
    const match = pattern.exec(text);
    if (match) {
      // Drivers report (column, line) - the first number is the source-string
      // index, the second is the line within it. Yes, really.
      const reported = parseInt(match[2], 10);
      const line = Math.max(1, reported - prologueLines);
      out.push({
        line,
        column: parseInt(match[1], 10),
        message: match[3],
        source: lines[line - 1],
      });
    } else if (text.startsWith('ERROR') || text.includes('error')) {
      out.push({ line: 1, column: 0, message: text });
    }
  }

  if (out.length === 0 && log.trim()) {
    out.push({ line: 1, column: 0, message: log.trim() });
  }
  return out;
}

function compileStage(
  gl: WebGL2RenderingContext,
  type: number,
  fullSource: string,
  userSource: string,
  prologueLines: number,
): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('Could not create shader object');

  gl.shaderSource(shader, fullSource);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? '';
    gl.deleteShader(shader);
    throw new ShaderCompileError(
      type === gl.VERTEX_SHADER ? 'vertex' : 'fragment',
      parseInfoLog(log, prologueLines, userSource),
      log,
    );
  }
  return shader;
}

export interface ProgramSources {
  vertex: string;
  fragment: string;
  /** Boilerplate lines prepended to each stage, for error remapping. */
  vertexPrologueLines?: number;
  fragmentPrologueLines?: number;
  /** The user-visible source, used to attach context to errors. */
  vertexUserSource?: string;
  fragmentUserSource?: string;
}

/**
 * A linked program with lazily-resolved, cached uniform locations.
 *
 * Uniform lookups are cached because the MilkDrop engine sets on the order of a
 * hundred uniforms per pass, and `getUniformLocation` is a synchronous driver
 * round trip that shows up in profiles if you call it in a loop.
 */
export class Program {
  readonly gl: WebGL2RenderingContext;
  readonly handle: WebGLProgram;
  private uniformCache = new Map<string, WebGLUniformLocation | null>();
  private attribCache = new Map<string, number>();
  private textureUnit = 0;

  constructor(gl: WebGL2RenderingContext, sources: ProgramSources) {
    this.gl = gl;

    const vs = compileStage(
      gl,
      gl.VERTEX_SHADER,
      sources.vertex,
      sources.vertexUserSource ?? sources.vertex,
      sources.vertexPrologueLines ?? 0,
    );

    let fs: WebGLShader;
    try {
      fs = compileStage(
        gl,
        gl.FRAGMENT_SHADER,
        sources.fragment,
        sources.fragmentUserSource ?? sources.fragment,
        sources.fragmentPrologueLines ?? 0,
      );
    } catch (err) {
      gl.deleteShader(vs);
      throw err;
    }

    const program = gl.createProgram();
    if (!program) {
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      throw new Error('Could not create program object');
    }

    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    // Shaders are reference-counted by the program; drop our references now.
    gl.detachShader(program, vs);
    gl.detachShader(program, fs);
    gl.deleteShader(vs);
    gl.deleteShader(fs);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program) ?? '';
      gl.deleteProgram(program);
      throw new ShaderCompileError('link', [{ line: 1, column: 0, message: log.trim() }], log);
    }

    this.handle = program;
  }

  use(): this {
    this.gl.useProgram(this.handle);
    this.textureUnit = 0;
    return this;
  }

  private loc(name: string): WebGLUniformLocation | null {
    let cached = this.uniformCache.get(name);
    if (cached === undefined) {
      cached = this.gl.getUniformLocation(this.handle, name);
      this.uniformCache.set(name, cached);
    }
    return cached;
  }

  attrib(name: string): number {
    let cached = this.attribCache.get(name);
    if (cached === undefined) {
      cached = this.gl.getAttribLocation(this.handle, name);
      this.attribCache.set(name, cached);
    }
    return cached;
  }

  /** True when the shader actually declares (and uses) this uniform. */
  has(name: string): boolean {
    return this.loc(name) !== null;
  }

  int(name: string, v: number): this {
    const l = this.loc(name);
    if (l) this.gl.uniform1i(l, v);
    return this;
  }
  ivec2(name: string, x: number, y: number): this {
    const l = this.loc(name);
    if (l) this.gl.uniform2i(l, x, y);
    return this;
  }
  float(name: string, v: number): this {
    const l = this.loc(name);
    if (l) this.gl.uniform1f(l, v);
    return this;
  }
  vec2(name: string, x: number, y: number): this {
    const l = this.loc(name);
    if (l) this.gl.uniform2f(l, x, y);
    return this;
  }
  vec3(name: string, x: number, y: number, z: number): this {
    const l = this.loc(name);
    if (l) this.gl.uniform3f(l, x, y, z);
    return this;
  }
  vec4(name: string, x: number, y: number, z: number, w: number): this {
    const l = this.loc(name);
    if (l) this.gl.uniform4f(l, x, y, z, w);
    return this;
  }
  floatArray(name: string, v: Float32Array): this {
    const l = this.loc(name);
    if (l) this.gl.uniform1fv(l, v);
    return this;
  }
  vec2Array(name: string, v: Float32Array): this {
    const l = this.loc(name);
    if (l) this.gl.uniform2fv(l, v);
    return this;
  }
  vec3Array(name: string, v: Float32Array): this {
    const l = this.loc(name);
    if (l) this.gl.uniform3fv(l, v);
    return this;
  }
  mat4(name: string, v: Float32Array): this {
    const l = this.loc(name);
    if (l) this.gl.uniformMatrix4fv(l, false, v);
    return this;
  }

  /**
   * Bind a texture to the next free unit and point `name` at it.
   * Units are assigned in bind order and reset on every `use()`.
   */
  texture(name: string, tex: WebGLTexture | null, target = this.gl.TEXTURE_2D): this {
    const l = this.loc(name);
    if (!l) return this;
    const unit = this.textureUnit++;
    this.gl.activeTexture(this.gl.TEXTURE0 + unit);
    this.gl.bindTexture(target, tex);
    this.gl.uniform1i(l, unit);
    return this;
  }

  dispose(): void {
    this.gl.deleteProgram(this.handle);
    this.uniformCache.clear();
    this.attribCache.clear();
  }
}
