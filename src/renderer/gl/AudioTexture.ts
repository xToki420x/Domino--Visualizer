import type { AudioFrame } from '../audio/types';
import { SPEC_SAMPLES } from '../audio/types';

/**
 * The audio texture visualizers sample.
 *
 * Layout matches Shadertoy exactly so ported shaders work unmodified:
 *
 *   row 0 (v = 0.25) : FFT magnitude, 0..1
 *   row 1 (v = 0.75) : waveform, remapped from -1..1 to 0..1
 *
 * Shadertoy uses 512x2 R8, and shaders routinely hardcode those dimensions, so
 * we match rather than "improve" on it. The extra precision would be wasted -
 * the analyser's own noise floor is well above 1/255.
 */
export class AudioTexture {
  private gl: WebGL2RenderingContext;
  readonly texture: WebGLTexture;
  readonly width = SPEC_SAMPLES;
  readonly height = 2;
  private data: Uint8Array;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.data = new Uint8Array(this.width * this.height);

    const tex = gl.createTexture();
    if (!tex) throw new Error('Could not create audio texture');
    this.texture = tex;

    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R8,
      this.width,
      this.height,
      0,
      gl.RED,
      gl.UNSIGNED_BYTE,
      this.data,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  update(frame: AudioFrame): void {
    const gl = this.gl;
    const w = this.width;
    const data = this.data;

    for (let i = 0; i < w; i++) {
      const spec = frame.spectrum[i];
      data[i] = spec <= 0 ? 0 : spec >= 1 ? 255 : (spec * 255) | 0;
    }

    // Mixing to mono here keeps the texture Shadertoy-shaped; presets that want
    // true stereo read frame.waveL/waveR through the engine instead.
    for (let i = 0; i < w; i++) {
      const mono = (frame.waveL[i] + frame.waveR[i]) * 0.5;
      const mapped = (mono + 1) * 0.5;
      data[w + i] = mapped <= 0 ? 0 : mapped >= 1 ? 255 : (mapped * 255) | 0;
    }

    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    // UNPACK_ALIGNMENT defaults to 4; our rows are 512 bytes so that is fine,
    // but set it explicitly in case SPEC_SAMPLES ever stops being a multiple.
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      this.width,
      this.height,
      gl.RED,
      gl.UNSIGNED_BYTE,
      data,
    );
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  }

  dispose(): void {
    this.gl.deleteTexture(this.texture);
  }
}

/**
 * Float waveform texture for the MilkDrop engine.
 *
 * MilkDrop's custom waves index per-sample stereo data and need real precision
 * and sign, which the 8-bit Shadertoy layout can't provide.
 *
 *   row 0 : left channel,  row 1 : right channel  (RG32F, x = value)
 */
export class WaveformTexture {
  private gl: WebGL2RenderingContext;
  readonly texture: WebGLTexture;
  readonly width: number;
  private data: Float32Array;

  constructor(gl: WebGL2RenderingContext, width = 512) {
    this.gl = gl;
    this.width = width;
    this.data = new Float32Array(width * 2);

    const tex = gl.createTexture();
    if (!tex) throw new Error('Could not create waveform texture');
    this.texture = tex;

    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, width, 2, 0, gl.RED, gl.FLOAT, this.data);
    // Float textures are only guaranteed filterable with OES_texture_float_linear,
    // and waves want exact sample values anyway.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  update(frame: AudioFrame): void {
    const gl = this.gl;
    const w = this.width;
    this.data.set(frame.waveL.subarray(0, w), 0);
    this.data.set(frame.waveR.subarray(0, w), w);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, 2, gl.RED, gl.FLOAT, this.data);
  }

  dispose(): void {
    this.gl.deleteTexture(this.texture);
  }
}
