import { compileEel, type CompiledEel } from './eel/Compiler';
import { MegaBuf, createScope, type EelBuffers, type EelScope } from './eel/Runtime';
import {
  PRESET_VARS,
  equationName,
  type CustomShape,
  type CustomWave,
  type MilkPreset,
} from './PresetModel';
import type { AudioFrame } from '../audio/types';

/**
 * Executes a preset's equation programs and holds the variable state they
 * share.
 *
 * MilkDrop's variable model is a single flat namespace per preset, persisting
 * across frames, seeded once by per_frame_init. Custom waves and shapes get
 * their *own* namespaces which inherit q1..q32 from the main one each frame -
 * that inheritance is the only channel presets have for driving a wave from the
 * main equations, so it has to happen in the right order every frame.
 */

/** Variables the engine writes before each per-frame evaluation. */
const INPUT_VARS = [
  'time',
  'fps',
  'frame',
  'progress',
  'bass',
  'mid',
  'treb',
  'bass_att',
  'mid_att',
  'treb_att',
  'vol',
  'vol_att',
  'meshx',
  'meshy',
  'aspectx',
  'aspecty',
  'pixelsx',
  'pixelsy',
] as const;

/** Variables per-pixel equations read and may overwrite, per vertex. */
export const PER_PIXEL_OUTPUTS = [
  'zoom',
  'zoomexp',
  'rot',
  'warp',
  'cx',
  'cy',
  'dx',
  'dy',
  'sx',
  'sy',
] as const;

export interface FrameInputs {
  time: number;
  fps: number;
  frame: number;
  /** 0..1 through the preset's display duration, used by some presets. */
  progress: number;
  meshX: number;
  meshY: number;
  aspectX: number;
  aspectY: number;
  pixelsX: number;
  pixelsY: number;
}

/** Snapshot of everything the renderer needs after per-frame equations run. */
export interface FrameState {
  zoom: number;
  zoomExp: number;
  rot: number;
  warp: number;
  cx: number;
  cy: number;
  dx: number;
  dy: number;
  sx: number;
  sy: number;
  decay: number;
  gamma: number;
  echoZoom: number;
  echoAlpha: number;
  echoOrient: number;
  waveMode: number;
  waveA: number;
  waveScale: number;
  waveSmoothing: number;
  waveMystery: number;
  waveR: number;
  waveG: number;
  waveB: number;
  waveX: number;
  waveY: number;
  waveAdditive: boolean;
  waveDots: boolean;
  waveThick: boolean;
  waveBrighten: boolean;
  modWaveAlphaByVolume: boolean;
  modWaveAlphaStart: number;
  modWaveAlphaEnd: number;
  obSize: number;
  obR: number;
  obG: number;
  obB: number;
  obA: number;
  ibSize: number;
  ibR: number;
  ibG: number;
  ibB: number;
  ibA: number;
  mvX: number;
  mvY: number;
  mvDX: number;
  mvDY: number;
  mvL: number;
  mvR: number;
  mvG: number;
  mvB: number;
  mvA: number;
  darkenCenter: boolean;
  invert: boolean;
  brighten: boolean;
  darken: boolean;
  solarize: boolean;
  texWrap: boolean;
  warpScale: number;
  warpSpeed: number;
  blur1Min: number;
  blur1Max: number;
  blur2Min: number;
  blur2Max: number;
  blur3Min: number;
  blur3Max: number;
  blur1EdgeDarken: number;
  /** q1..q32, index 0 unused so q[1] is q1. */
  q: Float32Array;
}

function createFrameState(): FrameState {
  return {
    zoom: 1, zoomExp: 1, rot: 0, warp: 1, cx: 0.5, cy: 0.5, dx: 0, dy: 0, sx: 1, sy: 1,
    decay: 0.98, gamma: 2, echoZoom: 1, echoAlpha: 0, echoOrient: 0,
    waveMode: 0, waveA: 0.8, waveScale: 1, waveSmoothing: 0.75, waveMystery: 0,
    waveR: 1, waveG: 1, waveB: 1, waveX: 0.5, waveY: 0.5,
    waveAdditive: false, waveDots: false, waveThick: false, waveBrighten: true,
    modWaveAlphaByVolume: false, modWaveAlphaStart: 0.75, modWaveAlphaEnd: 0.95,
    obSize: 0.01, obR: 0, obG: 0, obB: 0, obA: 0,
    ibSize: 0.01, ibR: 0.25, ibG: 0.25, ibB: 0.25, ibA: 0,
    mvX: 12, mvY: 9, mvDX: 0, mvDY: 0, mvL: 0.9, mvR: 1, mvG: 1, mvB: 1, mvA: 0,
    darkenCenter: false, invert: false, brighten: false, darken: false, solarize: false,
    texWrap: true, warpScale: 1, warpSpeed: 1,
    blur1Min: 0, blur1Max: 1, blur2Min: 0, blur2Max: 1, blur3Min: 0, blur3Max: 1,
    blur1EdgeDarken: 0.25,
    q: new Float32Array(33),
  };
}

/** Per-vertex results of the per-pixel equations. */
export interface PixelState {
  zoom: number;
  zoomExp: number;
  rot: number;
  warp: number;
  cx: number;
  cy: number;
  dx: number;
  dy: number;
  sx: number;
  sy: number;
}

export interface WaveFrameState {
  enabled: boolean;
  samples: number;
  sep: number;
  spectrum: boolean;
  useDots: boolean;
  drawThick: boolean;
  additive: boolean;
  scaling: number;
  smoothing: number;
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface ShapeFrameState {
  enabled: boolean;
  sides: number;
  additive: boolean;
  thickOutline: boolean;
  textured: boolean;
  numInstances: number;
  x: number;
  y: number;
  rad: number;
  ang: number;
  texAng: number;
  texZoom: number;
  r: number; g: number; b: number; a: number;
  r2: number; g2: number; b2: number; a2: number;
  borderR: number; borderG: number; borderB: number; borderA: number;
}

interface SubProgram {
  scope: EelScope;
  buffers: EelBuffers;
  init: CompiledEel;
  perFrame: CompiledEel;
  perPoint?: CompiledEel;
  initialized: boolean;
}

export class PresetRuntime {
  readonly preset: MilkPreset;
  readonly scope: EelScope;
  readonly buffers: EelBuffers;

  private perFrameInit: CompiledEel;
  private perFrameProgram: CompiledEel;
  private perPixelProgram: CompiledEel;
  private waveProgs: SubProgram[] = [];
  private shapeProgs: SubProgram[] = [];

  private initialized = false;
  readonly state: FrameState = createFrameState();
  readonly errors: string[] = [];

  /** True when the preset actually has per-pixel code worth evaluating. */
  readonly hasPerPixel: boolean;

  constructor(preset: MilkPreset) {
    this.preset = preset;
    this.scope = createScope();
    this.buffers = { mega: new MegaBuf(), gmega: new MegaBuf() };

    this.perFrameInit = compileEel(preset.perFrameInit);
    this.perFrameProgram = compileEel(preset.perFrame);
    this.perPixelProgram = compileEel(preset.perPixel);
    this.hasPerPixel = Boolean(preset.perPixel.trim()) && !this.perPixelProgram.error;

    this.collectError('per_frame_init', this.perFrameInit);
    this.collectError('per_frame', this.perFrameProgram);
    this.collectError('per_pixel', this.perPixelProgram);

    for (const wave of preset.waves) {
      this.waveProgs.push({
        scope: createScope(),
        buffers: { mega: new MegaBuf(), gmega: this.buffers.gmega },
        init: compileEel(wave.init),
        perFrame: compileEel(wave.perFrame),
        perPoint: compileEel(wave.perPoint),
        initialized: false,
      });
    }
    for (const shape of preset.shapes) {
      this.shapeProgs.push({
        scope: createScope(),
        buffers: { mega: new MegaBuf(), gmega: this.buffers.gmega },
        init: compileEel(shape.init),
        perFrame: compileEel(shape.perFrame),
        initialized: false,
      });
    }

    this.seedScope();
  }

  private collectError(label: string, compiled: CompiledEel): void {
    if (compiled.error) this.errors.push(`${label}: ${compiled.error}`);
  }

  /**
   * Pre-create every variable slot the preset can touch.
   *
   * Two reasons this matters. First, EEL treats unset variables as 0 while
   * JavaScript would give `undefined` and poison the arithmetic. Second, V8
   * keeps a stable hidden class for the scope object only if its shape stops
   * changing, and per-pixel code reads this object 100k+ times a second.
   */
  private seedScope(): void {
    const names = new Set<string>(INPUT_VARS);
    for (const spec of PRESET_VARS) names.add(equationName(spec));
    for (const name of PER_PIXEL_OUTPUTS) names.add(name);
    names.add('x');
    names.add('y');
    names.add('rad');
    names.add('ang');
    names.add('monitor');
    for (let i = 1; i <= 32; i++) names.add(`q${i}`);
    for (let i = 0; i < 100; i++) names.add(`reg${String(i).padStart(2, '0')}`);
    for (const program of [this.perFrameInit, this.perFrameProgram, this.perPixelProgram]) {
      for (const name of program.variables) names.add(name);
    }

    for (const name of names) this.scope[name] = 0;

    // Seed from the preset's base values so equations that only *read* a
    // variable see the author's chosen starting point.
    for (const spec of PRESET_VARS) {
      const value = this.preset.baseVals[spec.key];
      if (value !== undefined) this.scope[equationName(spec)] = value;
    }

    // Sub-namespaces for waves and shapes.
    this.preset.waves.forEach((wave, i) => {
      const program = this.waveProgs[i];
      const waveNames = new Set<string>([
        'sample', 'value1', 'value2', 'x', 'y', 'r', 'g', 'b', 'a',
        'samples', 'sep', 'scaling', 'smoothing', 'thick', 'additive', 'usedots', 'spectrum',
        'time', 'fps', 'frame', 'progress',
        'bass', 'mid', 'treb', 'bass_att', 'mid_att', 'treb_att', 'vol', 'vol_att',
        'meshx', 'meshy', 'aspectx', 'aspecty',
      ]);
      for (let q = 1; q <= 32; q++) waveNames.add(`q${q}`);
      for (let t = 1; t <= 8; t++) waveNames.add(`t${t}`);
      for (const p of [program.init, program.perFrame, program.perPoint]) {
        if (p) for (const name of p.variables) waveNames.add(name);
      }
      for (const name of waveNames) program.scope[name] = 0;
      program.scope.r = wave.r;
      program.scope.g = wave.g;
      program.scope.b = wave.b;
      program.scope.a = wave.a;
      program.scope.samples = wave.samples;
      program.scope.sep = wave.sep;
      program.scope.scaling = wave.scaling;
      program.scope.smoothing = wave.smoothing;
      this.collectError(`wave ${i}`, program.init);
      this.collectError(`wave ${i} per_frame`, program.perFrame);
      if (program.perPoint) this.collectError(`wave ${i} per_point`, program.perPoint);
    });

    this.preset.shapes.forEach((shape, i) => {
      const program = this.shapeProgs[i];
      const shapeNames = new Set<string>([
        'x', 'y', 'rad', 'ang', 'sides', 'textured', 'additive', 'thickoutline',
        'tex_ang', 'tex_zoom', 'num_inst', 'instance',
        'r', 'g', 'b', 'a', 'r2', 'g2', 'b2', 'a2',
        'border_r', 'border_g', 'border_b', 'border_a',
        'time', 'fps', 'frame', 'progress',
        'bass', 'mid', 'treb', 'bass_att', 'mid_att', 'treb_att', 'vol', 'vol_att',
        'meshx', 'meshy', 'aspectx', 'aspecty',
      ]);
      for (let q = 1; q <= 32; q++) shapeNames.add(`q${q}`);
      for (let t = 1; t <= 8; t++) shapeNames.add(`t${t}`);
      for (const p of [program.init, program.perFrame]) {
        for (const name of p.variables) shapeNames.add(name);
      }
      for (const name of shapeNames) program.scope[name] = 0;
      Object.assign(program.scope, {
        x: shape.x, y: shape.y, rad: shape.rad, ang: shape.ang,
        sides: shape.sides, textured: shape.textured ? 1 : 0,
        additive: shape.additive ? 1 : 0, thickoutline: shape.thickOutline ? 1 : 0,
        tex_ang: shape.texAng, tex_zoom: shape.texZoom, num_inst: shape.numInstances,
        r: shape.r, g: shape.g, b: shape.b, a: shape.a,
        r2: shape.r2, g2: shape.g2, b2: shape.b2, a2: shape.a2,
        border_r: shape.borderR, border_g: shape.borderG,
        border_b: shape.borderB, border_a: shape.borderA,
      });
      this.collectError(`shape ${i}`, program.init);
      this.collectError(`shape ${i} per_frame`, program.perFrame);
    });
  }

  /** Write the audio and timing inputs every equation block can read. */
  private writeInputs(scope: EelScope, audio: AudioFrame, inputs: FrameInputs): void {
    scope.time = inputs.time;
    scope.fps = inputs.fps;
    scope.frame = inputs.frame;
    scope.progress = inputs.progress;
    scope.bass = audio.bass;
    scope.mid = audio.mid;
    scope.treb = audio.treb;
    scope.bass_att = audio.bassAtt;
    scope.mid_att = audio.midAtt;
    scope.treb_att = audio.trebAtt;
    scope.vol = audio.vol;
    scope.vol_att = audio.volAtt;
    scope.meshx = inputs.meshX;
    scope.meshy = inputs.meshY;
    scope.aspectx = inputs.aspectX;
    scope.aspecty = inputs.aspectY;
    scope.pixelsx = inputs.pixelsX;
    scope.pixelsy = inputs.pixelsY;
  }

  runFrame(audio: AudioFrame, inputs: FrameInputs): FrameState {
    this.writeInputs(this.scope, audio, inputs);

    if (!this.initialized) {
      this.initialized = true;
      this.perFrameInit.run(this.scope, this.buffers);
    }

    this.perFrameProgram.run(this.scope, this.buffers);
    this.readFrameState();
    return this.state;
  }

  /** Copy equation results out of the scope into the typed FrameState. */
  private readFrameState(): void {
    const v = this.scope;
    const s = this.state;
    const num = (x: number, fallback: number): number => (Number.isFinite(x) ? x : fallback);

    s.zoom = num(v.zoom, 1);
    s.zoomExp = num(v.zoomexp, 1);
    s.rot = num(v.rot, 0);
    s.warp = num(v.warp, 1);
    s.cx = num(v.cx, 0.5);
    s.cy = num(v.cy, 0.5);
    s.dx = num(v.dx, 0);
    s.dy = num(v.dy, 0);
    s.sx = num(v.sx, 1);
    s.sy = num(v.sy, 1);
    // Decay outside 0..1 would either freeze the frame or blow it out.
    s.decay = Math.min(Math.max(num(v.decay, 0.98), 0), 1);
    s.gamma = num(v.gamma, 2);
    s.echoZoom = num(v.echo_zoom, 1);
    s.echoAlpha = num(v.echo_alpha, 0);
    s.echoOrient = num(v.echo_orient, 0);

    s.waveMode = Math.round(num(v.wave_mode, 0)) & 7;
    s.waveA = num(v.wave_a, 0.8);
    s.waveScale = num(v.wave_scale, 1);
    s.waveSmoothing = num(v.wave_smoothing, 0.75);
    s.waveMystery = num(v.wave_mystery, 0);
    s.waveR = num(v.wave_r, 1);
    s.waveG = num(v.wave_g, 1);
    s.waveB = num(v.wave_b, 1);
    s.waveX = num(v.wave_x, 0.5);
    s.waveY = num(v.wave_y, 0.5);
    s.waveAdditive = v.wave_additive > 0.5;
    s.waveDots = v.wave_usedots > 0.5;
    s.waveThick = v.wave_thick > 0.5;
    s.waveBrighten = v.wave_brighten > 0.5;
    s.modWaveAlphaByVolume = v.modwavealphabyvolume > 0.5;
    s.modWaveAlphaStart = num(v.modwavealphastart, 0.75);
    s.modWaveAlphaEnd = num(v.modwavealphaend, 0.95);

    s.obSize = num(v.ob_size, 0.01);
    s.obR = num(v.ob_r, 0); s.obG = num(v.ob_g, 0); s.obB = num(v.ob_b, 0); s.obA = num(v.ob_a, 0);
    s.ibSize = num(v.ib_size, 0.01);
    s.ibR = num(v.ib_r, 0.25); s.ibG = num(v.ib_g, 0.25);
    s.ibB = num(v.ib_b, 0.25); s.ibA = num(v.ib_a, 0);

    s.mvX = num(v.mv_x, 12); s.mvY = num(v.mv_y, 9);
    s.mvDX = num(v.mv_dx, 0); s.mvDY = num(v.mv_dy, 0);
    s.mvL = num(v.mv_l, 0.9);
    s.mvR = num(v.mv_r, 1); s.mvG = num(v.mv_g, 1);
    s.mvB = num(v.mv_b, 1); s.mvA = num(v.mv_a, 0);

    s.darkenCenter = v.darken_center > 0.5;
    s.invert = v.invert > 0.5;
    s.brighten = v.brighten > 0.5;
    s.darken = v.darken > 0.5;
    s.solarize = v.solarize > 0.5;
    s.texWrap = v.wrap > 0.5;
    s.warpScale = num(v.warp_scale, 1);
    s.warpSpeed = num(v.warp_speed, 1);

    s.blur1Min = num(v.b1n, 0); s.blur1Max = num(v.b1x, 1);
    s.blur2Min = num(v.b2n, 0); s.blur2Max = num(v.b2x, 1);
    s.blur3Min = num(v.b3n, 0); s.blur3Max = num(v.b3x, 1);
    s.blur1EdgeDarken = num(v.b1ed, 0.25);

    for (let i = 1; i <= 32; i++) s.q[i] = num(v[`q${i}`], 0);
  }

  /**
   * Evaluate per-pixel equations for one grid vertex.
   *
   * The motion variables are reset to the per-frame values first, because
   * MilkDrop re-runs per_pixel from the frame's baseline at every vertex rather
   * than letting one vertex's result leak into the next.
   */
  runPixel(x: number, y: number, rad: number, ang: number, out: PixelState): void {
    const v = this.scope;
    const s = this.state;

    v.x = x;
    v.y = y;
    v.rad = rad;
    v.ang = ang;
    v.zoom = s.zoom;
    v.zoomexp = s.zoomExp;
    v.rot = s.rot;
    v.warp = s.warp;
    v.cx = s.cx;
    v.cy = s.cy;
    v.dx = s.dx;
    v.dy = s.dy;
    v.sx = s.sx;
    v.sy = s.sy;

    this.perPixelProgram.run(v, this.buffers);

    out.zoom = Number.isFinite(v.zoom) ? v.zoom : 1;
    out.zoomExp = Number.isFinite(v.zoomexp) ? v.zoomexp : 1;
    out.rot = Number.isFinite(v.rot) ? v.rot : 0;
    out.warp = Number.isFinite(v.warp) ? v.warp : 1;
    out.cx = Number.isFinite(v.cx) ? v.cx : 0.5;
    out.cy = Number.isFinite(v.cy) ? v.cy : 0.5;
    out.dx = Number.isFinite(v.dx) ? v.dx : 0;
    out.dy = Number.isFinite(v.dy) ? v.dy : 0;
    out.sx = Number.isFinite(v.sx) ? v.sx : 1;
    out.sy = Number.isFinite(v.sy) ? v.sy : 1;
  }

  /** Copy q1..q32 into a sub-namespace, then run its per-frame equations. */
  private prepareSub(
    program: SubProgram,
    audio: AudioFrame,
    inputs: FrameInputs,
  ): void {
    this.writeInputs(program.scope, audio, inputs);
    for (let i = 1; i <= 32; i++) program.scope[`q${i}`] = this.state.q[i];
    if (!program.initialized) {
      program.initialized = true;
      program.init.run(program.scope, program.buffers);
    }
    program.perFrame.run(program.scope, program.buffers);
  }

  runWaveFrame(index: number, audio: AudioFrame, inputs: FrameInputs): WaveFrameState {
    const wave = this.preset.waves[index];
    const program = this.waveProgs[index];
    this.prepareSub(program, audio, inputs);
    const v = program.scope;
    return {
      enabled: wave.enabled,
      samples: Math.max(2, Math.min(Math.round(v.samples) || wave.samples, 512)),
      sep: Math.round(v.sep) || wave.sep,
      spectrum: wave.spectrum,
      useDots: v.usedots > 0.5 || wave.useDots,
      drawThick: v.thick > 0.5 || wave.drawThick,
      additive: v.additive > 0.5 || wave.additive,
      scaling: Number.isFinite(v.scaling) ? v.scaling : wave.scaling,
      smoothing: Number.isFinite(v.smoothing) ? v.smoothing : wave.smoothing,
      r: v.r, g: v.g, b: v.b, a: v.a,
    };
  }

  /** Evaluate a custom wave's per-point equations for one sample. */
  runWavePoint(
    index: number,
    sample: number,
    value1: number,
    value2: number,
    out: { x: number; y: number; r: number; g: number; b: number; a: number },
  ): void {
    const program = this.waveProgs[index];
    const v = program.scope;
    v.sample = sample;
    v.value1 = value1;
    v.value2 = value2;
    v.x = 0.5 + value1 * 0.5;
    v.y = 0.5 + value2 * 0.5;
    program.perPoint?.run(v, program.buffers);
    out.x = Number.isFinite(v.x) ? v.x : 0.5;
    out.y = Number.isFinite(v.y) ? v.y : 0.5;
    out.r = Number.isFinite(v.r) ? v.r : 1;
    out.g = Number.isFinite(v.g) ? v.g : 1;
    out.b = Number.isFinite(v.b) ? v.b : 1;
    out.a = Number.isFinite(v.a) ? v.a : 1;
  }

  runShapeFrame(
    index: number,
    instance: number,
    audio: AudioFrame,
    inputs: FrameInputs,
  ): ShapeFrameState {
    const shape = this.preset.shapes[index];
    const program = this.shapeProgs[index];
    program.scope.instance = instance;
    // Instance 0 does the q-copy and init; later instances continue from the
    // state instance 0 left behind, which is how MilkDrop animates them apart.
    if (instance === 0) {
      this.prepareSub(program, audio, inputs);
    } else {
      program.perFrame.run(program.scope, program.buffers);
    }
    const v = program.scope;
    const num = (x: number, fallback: number): number => (Number.isFinite(x) ? x : fallback);
    return {
      enabled: shape.enabled,
      sides: Math.max(3, Math.min(Math.round(num(v.sides, shape.sides)), 100)),
      additive: v.additive > 0.5,
      thickOutline: v.thickoutline > 0.5,
      textured: v.textured > 0.5,
      numInstances: Math.max(1, Math.min(Math.round(num(v.num_inst, shape.numInstances)), 1024)),
      x: num(v.x, shape.x),
      y: num(v.y, shape.y),
      rad: num(v.rad, shape.rad),
      ang: num(v.ang, shape.ang),
      texAng: num(v.tex_ang, shape.texAng),
      texZoom: num(v.tex_zoom, shape.texZoom),
      r: num(v.r, shape.r), g: num(v.g, shape.g), b: num(v.b, shape.b), a: num(v.a, shape.a),
      r2: num(v.r2, shape.r2), g2: num(v.g2, shape.g2),
      b2: num(v.b2, shape.b2), a2: num(v.a2, shape.a2),
      borderR: num(v.border_r, shape.borderR), borderG: num(v.border_g, shape.borderG),
      borderB: num(v.border_b, shape.borderB), borderA: num(v.border_a, shape.borderA),
    };
  }

  hasWave(index: number): boolean {
    return this.preset.waves[index]?.enabled ?? false;
  }
  hasShape(index: number): boolean {
    return this.preset.shapes[index]?.enabled ?? false;
  }
}
