/**
 * The editable model of a MilkDrop preset.
 *
 * Every scalar a preset can set is described in PRESET_VARS below rather than
 * hardcoded in the parser, because that one table then drives four things at
 * once: parsing, defaults, the UI's parameter editor, and serialisation back to
 * a .milk file. Adding a knob is a one-line change.
 */

export type VarGroup =
  | 'motion'
  | 'wave'
  | 'colour'
  | 'border'
  | 'motionVectors'
  | 'blur'
  | 'post'
  | 'meta';

export interface VarSpec {
  /** Key as it appears in the .milk file. */
  key: string;
  /** Name used inside preset equations, when different from the file key. */
  eq?: string;
  label: string;
  group: VarGroup;
  default: number;
  min: number;
  max: number;
  step?: number;
  type: 'float' | 'int' | 'bool';
  help?: string;
}

/**
 * MilkDrop's file keys and equation names disagree constantly - `fDecay` in the
 * file is `decay` in equations, `nWaveMode` is `wave_mode`, and so on. Mapping
 * both here is what lets per-frame code write to a variable and have the change
 * reach the renderer and survive a save.
 */
export const PRESET_VARS: VarSpec[] = [
  // --- motion / warp ----------------------------------------------------
  { key: 'zoom', label: 'Zoom', group: 'motion', default: 1, min: 0, max: 4, type: 'float', help: 'Per-frame scale of the previous frame. >1 zooms in.' },
  { key: 'rot', label: 'Rotation', group: 'motion', default: 0, min: -1, max: 1, type: 'float' },
  { key: 'cx', label: 'Center X', group: 'motion', default: 0.5, min: 0, max: 1, type: 'float' },
  { key: 'cy', label: 'Center Y', group: 'motion', default: 0.5, min: 0, max: 1, type: 'float' },
  { key: 'dx', label: 'Translate X', group: 'motion', default: 0, min: -0.5, max: 0.5, type: 'float' },
  { key: 'dy', label: 'Translate Y', group: 'motion', default: 0, min: -0.5, max: 0.5, type: 'float' },
  { key: 'warp', label: 'Warp Amount', group: 'motion', default: 1, min: 0, max: 4, type: 'float' },
  { key: 'sx', label: 'Stretch X', group: 'motion', default: 1, min: 0, max: 2, type: 'float' },
  { key: 'sy', label: 'Stretch Y', group: 'motion', default: 1, min: 0, max: 2, type: 'float' },
  { key: 'fWarpScale', eq: 'warp_scale', label: 'Warp Scale', group: 'motion', default: 1, min: 0.01, max: 10, type: 'float' },
  { key: 'fWarpAnimSpeed', eq: 'warp_speed', label: 'Warp Speed', group: 'motion', default: 1, min: 0, max: 10, type: 'float' },
  { key: 'fZoomExponent', eq: 'zoomexp', label: 'Zoom Exponent', group: 'motion', default: 1, min: 0.01, max: 10, type: 'float' },

  // --- decay / colour ---------------------------------------------------
  { key: 'fDecay', eq: 'decay', label: 'Decay', group: 'colour', default: 0.98, min: 0.5, max: 1, type: 'float', help: 'How much of the previous frame survives. 1.0 leaves permanent trails.' },
  { key: 'fGammaAdj', eq: 'gamma', label: 'Gamma', group: 'colour', default: 2, min: 0, max: 8, type: 'float' },
  { key: 'fVideoEchoZoom', eq: 'echo_zoom', label: 'Echo Zoom', group: 'colour', default: 1, min: 0, max: 8, type: 'float' },
  { key: 'fVideoEchoAlpha', eq: 'echo_alpha', label: 'Echo Alpha', group: 'colour', default: 0, min: 0, max: 1, type: 'float' },
  { key: 'nVideoEchoOrientation', eq: 'echo_orient', label: 'Echo Orientation', group: 'colour', default: 0, min: 0, max: 3, type: 'int' },
  { key: 'fShader', eq: 'fshader', label: 'Shader Blend', group: 'colour', default: 0, min: 0, max: 1, type: 'float' },

  // --- waveform ---------------------------------------------------------
  { key: 'nWaveMode', eq: 'wave_mode', label: 'Wave Mode', group: 'wave', default: 0, min: 0, max: 7, type: 'int' },
  { key: 'fWaveAlpha', eq: 'wave_a', label: 'Wave Alpha', group: 'wave', default: 0.8, min: 0, max: 4, type: 'float' },
  { key: 'fWaveScale', eq: 'wave_scale', label: 'Wave Scale', group: 'wave', default: 1, min: 0, max: 8, type: 'float' },
  { key: 'fWaveSmoothing', eq: 'wave_smoothing', label: 'Wave Smoothing', group: 'wave', default: 0.75, min: 0, max: 1, type: 'float' },
  { key: 'fWaveParam', eq: 'wave_mystery', label: 'Wave Mystery', group: 'wave', default: 0, min: -1, max: 1, type: 'float' },
  { key: 'wave_r', label: 'Wave Red', group: 'wave', default: 1, min: 0, max: 1, type: 'float' },
  { key: 'wave_g', label: 'Wave Green', group: 'wave', default: 1, min: 0, max: 1, type: 'float' },
  { key: 'wave_b', label: 'Wave Blue', group: 'wave', default: 1, min: 0, max: 1, type: 'float' },
  { key: 'wave_x', label: 'Wave X', group: 'wave', default: 0.5, min: 0, max: 1, type: 'float' },
  { key: 'wave_y', label: 'Wave Y', group: 'wave', default: 0.5, min: 0, max: 1, type: 'float' },
  { key: 'bAdditiveWaves', eq: 'wave_additive', label: 'Additive Waves', group: 'wave', default: 0, min: 0, max: 1, type: 'bool' },
  { key: 'bWaveDots', eq: 'wave_usedots', label: 'Dotted Waves', group: 'wave', default: 0, min: 0, max: 1, type: 'bool' },
  { key: 'bWaveThick', eq: 'wave_thick', label: 'Thick Waves', group: 'wave', default: 0, min: 0, max: 1, type: 'bool' },
  { key: 'bModWaveAlphaByVolume', eq: 'modwavealphabyvolume', label: 'Wave Alpha by Volume', group: 'wave', default: 0, min: 0, max: 1, type: 'bool' },
  { key: 'bMaximizeWaveColor', eq: 'wave_brighten', label: 'Maximize Wave Color', group: 'wave', default: 1, min: 0, max: 1, type: 'bool' },
  { key: 'fModWaveAlphaStart', eq: 'modwavealphastart', label: 'Wave Alpha Start', group: 'wave', default: 0.75, min: 0, max: 2, type: 'float' },
  { key: 'fModWaveAlphaEnd', eq: 'modwavealphaend', label: 'Wave Alpha End', group: 'wave', default: 0.95, min: 0, max: 2, type: 'float' },

  // --- borders ----------------------------------------------------------
  { key: 'ob_size', label: 'Outer Border Size', group: 'border', default: 0.01, min: 0, max: 0.5, type: 'float' },
  { key: 'ob_r', label: 'Outer Border R', group: 'border', default: 0, min: 0, max: 1, type: 'float' },
  { key: 'ob_g', label: 'Outer Border G', group: 'border', default: 0, min: 0, max: 1, type: 'float' },
  { key: 'ob_b', label: 'Outer Border B', group: 'border', default: 0, min: 0, max: 1, type: 'float' },
  { key: 'ob_a', label: 'Outer Border A', group: 'border', default: 0, min: 0, max: 1, type: 'float' },
  { key: 'ib_size', label: 'Inner Border Size', group: 'border', default: 0.01, min: 0, max: 0.5, type: 'float' },
  { key: 'ib_r', label: 'Inner Border R', group: 'border', default: 0.25, min: 0, max: 1, type: 'float' },
  { key: 'ib_g', label: 'Inner Border G', group: 'border', default: 0.25, min: 0, max: 1, type: 'float' },
  { key: 'ib_b', label: 'Inner Border B', group: 'border', default: 0.25, min: 0, max: 1, type: 'float' },
  { key: 'ib_a', label: 'Inner Border A', group: 'border', default: 0, min: 0, max: 1, type: 'float' },

  // --- motion vectors ---------------------------------------------------
  { key: 'nMotionVectorsX', eq: 'mv_x', label: 'Motion Vectors X', group: 'motionVectors', default: 12, min: 0, max: 64, type: 'float' },
  { key: 'nMotionVectorsY', eq: 'mv_y', label: 'Motion Vectors Y', group: 'motionVectors', default: 9, min: 0, max: 48, type: 'float' },
  { key: 'mv_dx', label: 'Motion Vector X Offset', group: 'motionVectors', default: 0, min: -1, max: 1, type: 'float' },
  { key: 'mv_dy', label: 'Motion Vector Y Offset', group: 'motionVectors', default: 0, min: -1, max: 1, type: 'float' },
  { key: 'mv_l', label: 'Motion Vector Length', group: 'motionVectors', default: 0.9, min: 0, max: 5, type: 'float' },
  { key: 'mv_r', label: 'Motion Vector R', group: 'motionVectors', default: 1, min: 0, max: 1, type: 'float' },
  { key: 'mv_g', label: 'Motion Vector G', group: 'motionVectors', default: 1, min: 0, max: 1, type: 'float' },
  { key: 'mv_b', label: 'Motion Vector B', group: 'motionVectors', default: 1, min: 0, max: 1, type: 'float' },
  { key: 'mv_a', label: 'Motion Vector A', group: 'motionVectors', default: 0, min: 0, max: 1, type: 'float' },

  // --- blur calibration -------------------------------------------------
  { key: 'b1n', label: 'Blur 1 Min', group: 'blur', default: 0, min: 0, max: 1, type: 'float' },
  { key: 'b2n', label: 'Blur 2 Min', group: 'blur', default: 0, min: 0, max: 1, type: 'float' },
  { key: 'b3n', label: 'Blur 3 Min', group: 'blur', default: 0, min: 0, max: 1, type: 'float' },
  { key: 'b1x', label: 'Blur 1 Max', group: 'blur', default: 1, min: 0, max: 1, type: 'float' },
  { key: 'b2x', label: 'Blur 2 Max', group: 'blur', default: 1, min: 0, max: 1, type: 'float' },
  { key: 'b3x', label: 'Blur 3 Max', group: 'blur', default: 1, min: 0, max: 1, type: 'float' },
  { key: 'b1ed', label: 'Blur 1 Edge Darken', group: 'blur', default: 0.25, min: 0, max: 1, type: 'float' },

  // --- post effects -----------------------------------------------------
  { key: 'bTexWrap', eq: 'wrap', label: 'Texture Wrap', group: 'post', default: 1, min: 0, max: 1, type: 'bool' },
  { key: 'bDarkenCenter', eq: 'darken_center', label: 'Darken Center', group: 'post', default: 0, min: 0, max: 1, type: 'bool' },
  { key: 'bRedBlueStereo', eq: 'red_blue', label: 'Red/Blue Stereo', group: 'post', default: 0, min: 0, max: 1, type: 'bool' },
  { key: 'bBrighten', eq: 'brighten', label: 'Brighten', group: 'post', default: 0, min: 0, max: 1, type: 'bool' },
  { key: 'bDarken', eq: 'darken', label: 'Darken', group: 'post', default: 0, min: 0, max: 1, type: 'bool' },
  { key: 'bSolarize', eq: 'solarize', label: 'Solarize', group: 'post', default: 0, min: 0, max: 1, type: 'bool' },
  { key: 'bInvert', eq: 'invert', label: 'Invert', group: 'post', default: 0, min: 0, max: 1, type: 'bool' },

  // --- metadata ---------------------------------------------------------
  { key: 'fRating', eq: 'rating', label: 'Rating', group: 'meta', default: 3, min: 0, max: 5, type: 'float' },
];

/** file key (lowercased) -> spec */
export const VAR_BY_KEY = new Map<string, VarSpec>(
  PRESET_VARS.map((spec) => [spec.key.toLowerCase(), spec]),
);
/** equation name -> spec */
export const VAR_BY_EQ = new Map<string, VarSpec>(
  PRESET_VARS.map((spec) => [(spec.eq ?? spec.key).toLowerCase(), spec]),
);

export function equationName(spec: VarSpec): string {
  return (spec.eq ?? spec.key).toLowerCase();
}

export interface CustomWave {
  index: number;
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
  init: string;
  perFrame: string;
  perPoint: string;
}

export interface CustomShape {
  index: number;
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
  r: number;
  g: number;
  b: number;
  a: number;
  r2: number;
  g2: number;
  b2: number;
  a2: number;
  borderR: number;
  borderG: number;
  borderB: number;
  borderA: number;
  init: string;
  perFrame: string;
}

export interface MilkPreset {
  name: string;
  /** File-key -> value, covering everything in PRESET_VARS. */
  baseVals: Record<string, number>;
  perFrameInit: string;
  perFrame: string;
  perPixel: string;
  /** MilkDrop 2 pixel shaders, empty string when the preset is MilkDrop 1. */
  warpShader: string;
  compShader: string;
  waves: CustomWave[];
  shapes: CustomShape[];
  /** Any keys we didn't recognise, preserved so saving round-trips cleanly. */
  extra: Record<string, string>;
  /** Non-fatal problems found while parsing, surfaced in the UI. */
  warnings: string[];
}

export function defaultBaseVals(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const spec of PRESET_VARS) out[spec.key] = spec.default;
  return out;
}

export function defaultCustomWave(index: number): CustomWave {
  return {
    index,
    enabled: false,
    samples: 512,
    sep: 0,
    spectrum: false,
    useDots: false,
    drawThick: false,
    additive: false,
    scaling: 1,
    smoothing: 0.5,
    r: 1,
    g: 1,
    b: 1,
    a: 1,
    init: '',
    perFrame: '',
    perPoint: '',
  };
}

export function defaultCustomShape(index: number): CustomShape {
  return {
    index,
    enabled: false,
    sides: 4,
    additive: false,
    thickOutline: false,
    textured: false,
    numInstances: 1,
    x: 0.5,
    y: 0.5,
    rad: 0.1,
    ang: 0,
    texAng: 0,
    texZoom: 1,
    r: 1,
    g: 0,
    b: 0,
    a: 1,
    r2: 0,
    g2: 1,
    b2: 0,
    a2: 0,
    borderR: 1,
    borderG: 1,
    borderB: 1,
    borderA: 0.1,
    init: '',
    perFrame: '',
  };
}

export function createEmptyPreset(name = 'Untitled'): MilkPreset {
  return {
    name,
    baseVals: defaultBaseVals(),
    perFrameInit: '',
    perFrame: '',
    perPixel: '',
    warpShader: '',
    compShader: '',
    waves: [0, 1, 2, 3].map(defaultCustomWave),
    shapes: [0, 1, 2, 3].map(defaultCustomShape),
    extra: {},
    warnings: [],
  };
}

/** Deep copy, so the editor can mutate a working copy without touching the original. */
export function clonePreset(preset: MilkPreset): MilkPreset {
  return {
    ...preset,
    baseVals: { ...preset.baseVals },
    waves: preset.waves.map((w) => ({ ...w })),
    shapes: preset.shapes.map((s) => ({ ...s })),
    extra: { ...preset.extra },
    warnings: [...preset.warnings],
  };
}
