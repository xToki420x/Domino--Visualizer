/** WebGL2 context creation plus the capability probing everything else keys off. */

export interface GLCaps {
  maxTextureSize: number;
  maxVertexTextureUnits: number;
  /** Float textures are renderable - required for HDR feedback buffers. */
  colorBufferFloat: boolean;
  /** Linear filtering on float textures. Without it we fall back to half-float. */
  floatLinear: boolean;
  halfFloatLinear: boolean;
  maxSamples: number;
  renderer: string;
  vendor: string;
}

export class GLContext {
  readonly gl: WebGL2RenderingContext;
  readonly canvas: HTMLCanvasElement;
  readonly caps: GLCaps;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      // We composite into the default framebuffer every frame, so there is
      // nothing to preserve, and telling the driver that is faster.
      preserveDrawingBuffer: false,
      premultipliedAlpha: false,
      // Deliberately NOT desynchronized: it shaves a frame of latency but
      // bypasses compositor sync, which tears visibly on full-screen animation.
      // For a visualizer a clean frame matters far more than the latency.
      desynchronized: false,
      powerPreference: 'high-performance',
      failIfMajorPerformanceCaveat: false,
    });

    if (!gl) {
      throw new Error(
        'WebGL2 is not available. Domino needs a GPU with WebGL2 support (any GPU from the last decade).',
      );
    }
    this.gl = gl;

    // These extensions are what let feedback buffers hold values outside 0..1,
    // which most interesting shader effects depend on.
    const colorBufferFloat = Boolean(gl.getExtension('EXT_color_buffer_float'));
    const floatLinear = Boolean(gl.getExtension('OES_texture_float_linear'));
    gl.getExtension('EXT_float_blend');

    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    this.caps = {
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
      maxVertexTextureUnits: gl.getParameter(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS) as number,
      colorBufferFloat,
      floatLinear,
      // WebGL2 guarantees linear filtering for half-float, so this is our floor.
      halfFloatLinear: true,
      maxSamples: (gl.getParameter(gl.MAX_SAMPLES) as number) ?? 0,
      renderer: debugInfo
        ? ((gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) as string) ?? 'unknown')
        : ((gl.getParameter(gl.RENDERER) as string) ?? 'unknown'),
      vendor: debugInfo
        ? ((gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) as string) ?? 'unknown')
        : ((gl.getParameter(gl.VENDOR) as string) ?? 'unknown'),
    };

    canvas.addEventListener('webglcontextlost', (e) => {
      // Without preventDefault the context can never be restored.
      e.preventDefault();
      this.contextLost = true;
      this.lostListeners.forEach((cb) => cb());
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.contextLost = false;
      this.restoredListeners.forEach((cb) => cb());
    });
  }

  contextLost = false;
  private lostListeners = new Set<() => void>();
  private restoredListeners = new Set<() => void>();

  onContextLost(cb: () => void): () => void {
    this.lostListeners.add(cb);
    return () => this.lostListeners.delete(cb);
  }
  onContextRestored(cb: () => void): () => void {
    this.restoredListeners.add(cb);
    return () => this.restoredListeners.delete(cb);
  }

  /**
   * The best float-ish internal format this GPU can both render to and filter.
   * Float first, then half-float, then plain 8-bit as the universal fallback.
   */
  bestFloatFormat(): { internalFormat: number; type: number; hdr: boolean } {
    const gl = this.gl;
    if (this.caps.colorBufferFloat && this.caps.floatLinear) {
      return { internalFormat: gl.RGBA16F, type: gl.HALF_FLOAT, hdr: true };
    }
    if (this.caps.colorBufferFloat) {
      return { internalFormat: gl.RGBA16F, type: gl.HALF_FLOAT, hdr: true };
    }
    return { internalFormat: gl.RGBA8, type: gl.UNSIGNED_BYTE, hdr: false };
  }

  /**
   * Size the drawing buffer to the element, honouring devicePixelRatio and a
   * user render-scale. Returns true when the size actually changed.
   */
  resize(scale = 1): boolean {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(
      1,
      Math.min(Math.floor(rect.width * dpr * scale), this.caps.maxTextureSize),
    );
    const height = Math.max(
      1,
      Math.min(Math.floor(rect.height * dpr * scale), this.caps.maxTextureSize),
    );
    if (this.canvas.width === width && this.canvas.height === height) return false;
    this.canvas.width = width;
    this.canvas.height = height;
    return true;
  }

  get width(): number {
    return this.canvas.width;
  }
  get height(): number {
    return this.canvas.height;
  }
}
