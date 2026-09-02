import type { GeometryBatch } from './GeometryBatch';
import type { FrameInputs, FrameState, PresetRuntime } from './PresetRuntime';
import type { AudioFrame } from '../audio/types';

/**
 * Everything MilkDrop draws *on top of* the warped frame each cycle: the
 * waveform, custom waves, custom shapes, borders, the darkened centre and
 * motion vectors.
 *
 * All of these are generated on the CPU into clip space (-1..1) and streamed
 * through the geometry batch. Screen coordinates here follow MilkDrop's own
 * convention - x and y run 0..1 with y = 0 at the *top* - so preset values like
 * `wave_y = 0.5` land where their authors expected.
 */

/** MilkDrop screen coords (0..1, y down) -> clip space. */
function toClipX(x: number): number {
  return x * 2 - 1;
}
function toClipY(y: number): number {
  return 1 - y * 2;
}

/** Smooth the waveform the way MilkDrop does before drawing it. */
function smoothWave(src: Float32Array, dst: Float32Array, count: number, smoothing: number): void {
  const s = Math.min(Math.max(smoothing, 0), 1);
  // MilkDrop's smoothing is a symmetric 3-tap whose centre weight falls as the
  // smoothing parameter rises.
  const w = 1 + s * 2;
  const total = w + 2;
  for (let i = 0; i < count; i++) {
    const prev = src[Math.max(i - 1, 0)];
    const next = src[Math.min(i + 1, count - 1)];
    dst[i] = (prev + src[i] * w + next) / total;
  }
}

const scratchA = new Float32Array(512);
const scratchB = new Float32Array(512);

export interface DrawContext {
  batch: GeometryBatch;
  audio: AudioFrame;
  state: FrameState;
  aspectX: number;
  aspectY: number;
  /** Pixel size of the render target, for line thickness in clip units. */
  width: number;
  height: number;
}

/**
 * The built-in waveform, modes 0-7.
 *
 * These reproduce the *character* of MilkDrop's eight modes - circular,
 * oscilloscope, spiro, blob, derivative, hash and line - rather than being
 * bit-exact ports of its geometry code. Presets select a mode expecting a
 * recognisable shape and drive it with wave_x/wave_y/wave_scale/wave_mystery,
 * all of which behave here as they should.
 */
export function drawWaveform(ctx: DrawContext): void {
  const { batch, audio, state } = ctx;
  if (state.waveA <= 0.001) return;

  const samples = 480;
  const half = samples >> 1;

  smoothWave(audio.waveL, scratchA, samples, state.waveSmoothing);
  smoothWave(audio.waveR, scratchB, samples, state.waveSmoothing);

  let alpha = state.waveA;
  if (state.modWaveAlphaByVolume) {
    // Fade the wave in across the configured volume window.
    const span = state.modWaveAlphaEnd - state.modWaveAlphaStart;
    const t = span > 1e-4 ? (audio.vol - state.modWaveAlphaStart) / span : 1;
    alpha *= Math.min(Math.max(t, 0), 1);
  }
  if (alpha <= 0.001) return;

  let r = state.waveR;
  let g = state.waveG;
  let b = state.waveB;
  if (state.waveBrighten) {
    // MilkDrop's "maximize wave color" scales the brightest channel to 1.
    const peak = Math.max(r, g, b);
    if (peak > 1e-4) {
      r /= peak;
      g /= peak;
      b /= peak;
    }
  }

  const scale = state.waveScale * 0.5;
  const mystery = state.waveMystery;
  const cx = state.waveX;
  // MilkDrop's wave_y is measured from the bottom, unlike shape positions.
  const cy = 1 - state.waveY;
  const thickness = state.waveThick ? 3.0 / ctx.height * 2 : 1.2 / ctx.height * 2;

  const points: number[] = [];

  switch (state.waveMode) {
    case 0: {
      // Circular wave: radius modulated by the signal.
      const count = half;
      for (let i = 0; i <= count; i++) {
        const t = (i % count) / count;
        const angle = t * Math.PI * 2;
        const value = (scratchA[i % count] + scratchB[i % count]) * 0.5;
        const radius = 0.35 + 0.25 * mystery + value * scale * 0.6;
        points.push(
          toClipX(cx + radius * Math.cos(angle) * ctx.aspectY),
          toClipY(cy + radius * Math.sin(angle) * ctx.aspectX),
        );
      }
      break;
    }

    case 1: {
      // X-Y oscilloscope: left channel against right.
      for (let i = 0; i < half; i++) {
        points.push(
          toClipX(cx + scratchA[i] * scale * 0.5),
          toClipY(cy + scratchB[i] * scale * 0.5),
        );
      }
      break;
    }

    case 2:
    case 3: {
      // Centred spiro: the two channels drive a rotating radius.
      const count = half;
      const twist = state.waveMode === 2 ? 1 : 2;
      for (let i = 0; i < count; i++) {
        const t = i / count;
        const angle = t * Math.PI * 2 * twist + mystery * Math.PI;
        const radius = 0.2 + (scratchA[i] * 0.5 + scratchB[i] * 0.5) * scale;
        points.push(
          toClipX(cx + radius * Math.cos(angle) * ctx.aspectY),
          toClipY(cy + radius * Math.sin(angle) * ctx.aspectX),
        );
      }
      break;
    }

    case 4: {
      // Vertical blob: a horizontal sweep displaced vertically.
      for (let i = 0; i < samples; i++) {
        const t = i / (samples - 1);
        points.push(
          toClipX(0.05 + t * 0.9 + mystery * 0.1),
          toClipY(cy + scratchA[i] * scale * 0.4),
        );
      }
      break;
    }

    case 5: {
      // Derivative line: emphasises transients.
      for (let i = 1; i < samples; i++) {
        const t = i / (samples - 1);
        const d = (scratchA[i] - scratchA[i - 1]) * 8;
        points.push(toClipX(0.05 + t * 0.9), toClipY(cy + d * scale * 0.4));
      }
      break;
    }

    case 6: {
      // Explosive hash: angled line whose slope follows wave_mystery.
      const angle = mystery * Math.PI;
      const ca = Math.cos(angle);
      const sa = Math.sin(angle);
      for (let i = 0; i < samples; i++) {
        const t = i / (samples - 1) - 0.5;
        const d = scratchA[i] * scale * 0.35;
        points.push(
          toClipX(cx + t * ca - d * sa),
          toClipY(cy + t * sa + d * ca),
        );
      }
      break;
    }

    default: {
      // Mode 7: two parallel lines, one per channel.
      for (let i = 0; i < samples; i++) {
        const t = i / (samples - 1);
        points.push(toClipX(0.05 + t * 0.9), toClipY(cy - 0.06 + scratchA[i] * scale * 0.3));
      }
      emitStrip(batch, points, r, g, b, alpha, state, thickness, ctx);
      points.length = 0;
      for (let i = 0; i < samples; i++) {
        const t = i / (samples - 1);
        points.push(toClipX(0.05 + t * 0.9), toClipY(cy + 0.06 + scratchB[i] * scale * 0.3));
      }
      break;
    }
  }

  emitStrip(batch, points, r, g, b, alpha, state, thickness, ctx);
}

function emitStrip(
  batch: GeometryBatch,
  points: number[],
  r: number,
  g: number,
  b: number,
  a: number,
  state: FrameState,
  thickness: number,
  ctx: DrawContext,
): void {
  if (points.length < 4) return;
  const blend = state.waveAdditive ? 'additive' : 'alpha';

  if (state.waveDots) {
    batch.begin();
    for (let i = 0; i < points.length; i += 2) {
      // Points are one pixel; draw a tiny quad so dots stay visible at any DPI.
      const x = points[i];
      const y = points[i + 1];
      const s = thickness;
      batch.vertex(x - s, y - s, r, g, b, a);
      batch.vertex(x + s, y - s, r, g, b, a);
      batch.vertex(x, y + s, r, g, b, a);
    }
    batch.flush('triangles', blend);
    return;
  }

  batch.begin();
  for (let i = 0; i + 3 < points.length; i += 2) {
    batch.thickSegment(
      points[i], points[i + 1],
      points[i + 2], points[i + 3],
      r, g, b, a,
      thickness,
    );
  }
  batch.flush('triangles', blend);
}

/** Custom waves 0-3, driven by their own per-point equations. */
export function drawCustomWaves(
  ctx: DrawContext,
  runtime: PresetRuntime,
  audio: AudioFrame,
  inputs: FrameInputs,
): void {
  const point = { x: 0.5, y: 0.5, r: 1, g: 1, b: 1, a: 1 };

  for (let index = 0; index < 4; index++) {
    if (!runtime.hasWave(index)) continue;
    const wave = runtime.runWaveFrame(index, audio, inputs);
    if (!wave.enabled || wave.a <= 0.001) continue;

    const count = Math.min(wave.samples, 512);
    if (count < 2) continue;

    smoothWave(audio.waveL, scratchA, count, wave.smoothing);
    smoothWave(audio.waveR, scratchB, count, wave.smoothing);

    const sep = Math.abs(wave.sep) | 0;
    const verts: number[] = [];
    const colors: number[] = [];

    for (let i = 0; i < count; i++) {
      const sample = i / (count - 1);
      // `sep` offsets the second channel's read position, which is how presets
      // get the two traces to diverge.
      const v1 = (wave.spectrum ? audio.spectrum[i] : scratchA[i]) * wave.scaling;
      const v2 =
        (wave.spectrum ? audio.spectrum[Math.min(i + sep, 511)] : scratchB[Math.min(i + sep, count - 1)]) *
        wave.scaling;

      runtime.runWavePoint(index, sample, v1, v2, point);
      verts.push(toClipX(point.x), toClipY(point.y));
      colors.push(point.r, point.g, point.b, point.a * wave.a);
    }

    const blend = wave.additive ? 'additive' : 'alpha';
    const thickness = (wave.drawThick ? 3.0 : 1.2) / ctx.height * 2;

    ctx.batch.begin();
    if (wave.useDots) {
      for (let i = 0; i < verts.length; i += 2) {
        const c = (i / 2) * 4;
        const s = thickness;
        ctx.batch.vertex(verts[i] - s, verts[i + 1] - s, colors[c], colors[c + 1], colors[c + 2], colors[c + 3]);
        ctx.batch.vertex(verts[i] + s, verts[i + 1] - s, colors[c], colors[c + 1], colors[c + 2], colors[c + 3]);
        ctx.batch.vertex(verts[i], verts[i + 1] + s, colors[c], colors[c + 1], colors[c + 2], colors[c + 3]);
      }
    } else {
      for (let i = 0; i + 3 < verts.length; i += 2) {
        const c = (i / 2) * 4;
        ctx.batch.thickSegment(
          verts[i], verts[i + 1], verts[i + 2], verts[i + 3],
          colors[c], colors[c + 1], colors[c + 2], colors[c + 3],
          thickness,
        );
      }
    }
    ctx.batch.flush('triangles', blend);
  }
}

/** Custom shapes 0-3: an n-gon fan with an optional outline, per instance. */
export function drawCustomShapes(
  ctx: DrawContext,
  runtime: PresetRuntime,
  audio: AudioFrame,
  inputs: FrameInputs,
): void {
  for (let index = 0; index < 4; index++) {
    if (!runtime.hasShape(index)) continue;

    // Instance 0 establishes num_inst, so the count is only known after it runs.
    let instanceCount = 1;
    for (let instance = 0; instance < instanceCount; instance++) {
      const shape = runtime.runShapeFrame(index, instance, audio, inputs);
      if (instance === 0) {
        instanceCount = Math.min(shape.numInstances, 128);
        if (!shape.enabled) break;
      }
      if (shape.a <= 0.001 && shape.a2 <= 0.001 && shape.borderA <= 0.001) continue;

      const cx = toClipX(shape.x);
      const cy = toClipY(shape.y);
      // Radius is in screen-height units; correct x so shapes stay circular.
      const rx = shape.rad * ctx.aspectY;
      const ry = shape.rad * ctx.aspectX;
      const sides = shape.sides;
      const blend = shape.additive ? 'additive' : 'alpha';

      const batch = ctx.batch;
      batch.begin();
      // Triangle fan: centre colour is r/g/b/a, rim colour is r2/g2/b2/a2.
      for (let s = 0; s < sides; s++) {
        const a0 = shape.ang + (s / sides) * Math.PI * 2;
        const a1 = shape.ang + ((s + 1) / sides) * Math.PI * 2;
        batch.vertex(cx, cy, shape.r, shape.g, shape.b, shape.a);
        batch.vertex(
          cx + Math.cos(a0) * rx, cy + Math.sin(a0) * ry,
          shape.r2, shape.g2, shape.b2, shape.a2,
        );
        batch.vertex(
          cx + Math.cos(a1) * rx, cy + Math.sin(a1) * ry,
          shape.r2, shape.g2, shape.b2, shape.a2,
        );
      }
      batch.flush('triangles', blend);

      if (shape.borderA > 0.001) {
        const thickness = (shape.thickOutline ? 3.0 : 1.2) / ctx.height * 2;
        batch.begin();
        for (let s = 0; s < sides; s++) {
          const a0 = shape.ang + (s / sides) * Math.PI * 2;
          const a1 = shape.ang + ((s + 1) / sides) * Math.PI * 2;
          batch.thickSegment(
            cx + Math.cos(a0) * rx, cy + Math.sin(a0) * ry,
            cx + Math.cos(a1) * rx, cy + Math.sin(a1) * ry,
            shape.borderR, shape.borderG, shape.borderB, shape.borderA,
            thickness,
          );
        }
        batch.flush('triangles', blend);
      }
    }
  }
}

/** The inner and outer border rectangles. */
export function drawBorders(ctx: DrawContext): void {
  const { batch, state } = ctx;

  const rings: Array<{ size: number; r: number; g: number; b: number; a: number }> = [
    { size: state.obSize, r: state.obR, g: state.obG, b: state.obB, a: state.obA },
    { size: state.ibSize, r: state.ibR, g: state.ibG, b: state.ibB, a: state.ibA },
  ];

  let inset = 0;
  for (const ring of rings) {
    if (ring.a <= 0.001 || ring.size <= 0) {
      inset += ring.size * 2;
      continue;
    }
    const outer = 1 - inset;
    const inner = outer - ring.size * 2;

    batch.begin();
    // Four quads forming a frame between `inner` and `outer`.
    const quads: Array<[number, number, number, number]> = [
      [-outer, outer, outer, inner],   // top
      [-outer, -inner, outer, -outer], // bottom
      [-outer, inner, -inner, -inner], // left
      [inner, inner, outer, -inner],   // right
    ];
    for (const [x0, y0, x1, y1] of quads) {
      batch.vertex(x0, y0, ring.r, ring.g, ring.b, ring.a);
      batch.vertex(x1, y0, ring.r, ring.g, ring.b, ring.a);
      batch.vertex(x0, y1, ring.r, ring.g, ring.b, ring.a);
      batch.vertex(x0, y1, ring.r, ring.g, ring.b, ring.a);
      batch.vertex(x1, y0, ring.r, ring.g, ring.b, ring.a);
      batch.vertex(x1, y1, ring.r, ring.g, ring.b, ring.a);
    }
    batch.flush('triangles', 'alpha');
    inset += ring.size * 2;
  }
}

/**
 * MilkDrop's "darken center" - a small dark blob at the middle of the frame.
 * It exists to stop feedback zooms from saturating into a white core.
 */
export function drawDarkenCenter(ctx: DrawContext): void {
  if (!ctx.state.darkenCenter) return;
  const batch = ctx.batch;
  const radius = 0.05;
  const rx = radius * ctx.aspectY;
  const ry = radius * ctx.aspectX;
  const segments = 24;

  batch.begin();
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    batch.vertex(0, 0, 0, 0, 0, 0.0784);
    batch.vertex(Math.cos(a0) * rx, Math.sin(a0) * ry, 0, 0, 0, 0);
    batch.vertex(Math.cos(a1) * rx, Math.sin(a1) * ry, 0, 0, 0, 0);
  }
  batch.flush('triangles', 'alpha');
}

/** Motion vectors: a field of short streaks showing the warp direction. */
export function drawMotionVectors(ctx: DrawContext): void {
  const { batch, state } = ctx;
  if (state.mvA <= 0.001) return;

  const nx = Math.min(Math.max(Math.round(state.mvX), 0), 64);
  const ny = Math.min(Math.max(Math.round(state.mvY), 0), 48);
  if (nx < 1 || ny < 1) return;

  const length = state.mvL * 0.02;
  const thickness = 1.2 / ctx.height * 2;

  batch.begin();
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x = (i + 0.5) / nx + state.mvDX;
      const y = (j + 0.5) / ny + state.mvDY;
      if (x < 0 || x > 1 || y < 0 || y > 1) continue;
      const cx = toClipX(x);
      const cy = toClipY(y);
      batch.thickSegment(
        cx, cy,
        cx + length, cy,
        state.mvR, state.mvG, state.mvB, state.mvA,
        thickness,
      );
    }
  }
  batch.flush('triangles', 'alpha');
}
