import {
  createEmptyPreset,
  PRESET_VARS,
  VAR_BY_KEY,
  type CustomShape,
  type CustomWave,
  type MilkPreset,
} from './PresetModel';

/**
 * Reader and writer for MilkDrop .milk preset files.
 *
 * The format is an INI-ish list of `key=value` lines with three quirks that
 * drive the whole design here:
 *
 *  1. Code is split across numbered keys (`per_frame_1`, `per_frame_2`, ...)
 *     that must be reassembled in *numeric* order - sorting them as strings
 *     puts `per_frame_10` between 1 and 2 and silently scrambles the program.
 *  2. Shader lines are additionally prefixed with a backtick after the `=`.
 *  3. Values may themselves contain `=`, so only the first one separates.
 *
 * Anything unrecognised is preserved in `extra` so that editing and re-saving a
 * preset never quietly drops data the user cared about.
 */

interface NumberedLine {
  order: number;
  text: string;
}

/** Sort numbered fragments numerically and join them into one program. */
function assemble(lines: NumberedLine[]): string {
  return lines
    .sort((a, b) => a.order - b.order)
    .map((line) => line.text)
    .join('\n');
}

export function parseMilk(source: string, name = 'Untitled'): MilkPreset {
  const preset = createEmptyPreset(name);

  // Numbered fragments are gathered first and assembled once at the end,
  // because files do not guarantee the keys appear in order.
  const buckets = {
    perFrameInit: [] as NumberedLine[],
    perFrame: [] as NumberedLine[],
    perPixel: [] as NumberedLine[],
    warp: [] as NumberedLine[],
    comp: [] as NumberedLine[],
  };
  const waveCode: Record<number, { init: NumberedLine[]; perFrame: NumberedLine[]; perPoint: NumberedLine[] }> = {};
  const shapeCode: Record<number, { init: NumberedLine[]; perFrame: NumberedLine[] }> = {};

  for (let i = 0; i < 4; i++) {
    waveCode[i] = { init: [], perFrame: [], perPoint: [] };
    shapeCode[i] = { init: [], perFrame: [] };
  }

  // Handle all three line endings; presets travel between platforms a lot.
  const lines = source.split(/\r\n|\r|\n/);

  for (const rawLine of lines) {
    const line = rawLine.replace(/^﻿/, '');
    if (!line.trim()) continue;
    // Section headers like [preset00] carry no information we need.
    if (line.trimStart().startsWith('[')) continue;

    const eq = line.indexOf('=');
    if (eq < 0) continue;

    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1);
    const lowerKey = key.toLowerCase();

    /* --- pixel shaders: warp_1=`... and comp_1=`... --------------------- */
    let match = /^(warp|comp)_(\d+)$/.exec(lowerKey);
    if (match) {
      const bucket = match[1] === 'warp' ? buckets.warp : buckets.comp;
      // Strip the single leading backtick MilkDrop uses as a line marker.
      bucket.push({ order: parseInt(match[2], 10), text: value.replace(/^`/, '') });
      continue;
    }

    /* --- main equation blocks ------------------------------------------- */
    match = /^per_frame_init_(\d+)$/.exec(lowerKey);
    if (match) {
      buckets.perFrameInit.push({ order: parseInt(match[1], 10), text: value });
      continue;
    }
    match = /^per_frame_(\d+)$/.exec(lowerKey);
    if (match) {
      buckets.perFrame.push({ order: parseInt(match[1], 10), text: value });
      continue;
    }
    match = /^per_pixel_(\d+)$/.exec(lowerKey);
    if (match) {
      buckets.perPixel.push({ order: parseInt(match[1], 10), text: value });
      continue;
    }

    /* --- custom wave code: wave_0_per_point1 ---------------------------- */
    match = /^wave_(\d+)_(init|per_frame|per_point)(\d+)$/.exec(lowerKey);
    if (match) {
      const waveIndex = parseInt(match[1], 10);
      if (waveIndex >= 0 && waveIndex < 4) {
        const order = parseInt(match[3], 10);
        const which = match[2] === 'init' ? 'init' : match[2] === 'per_frame' ? 'perFrame' : 'perPoint';
        waveCode[waveIndex][which].push({ order, text: value });
      }
      continue;
    }

    /* --- custom shape code: shape_0_per_frame1 -------------------------- */
    match = /^shape_(\d+)_(init|per_frame)(\d+)$/.exec(lowerKey);
    if (match) {
      const shapeIndex = parseInt(match[1], 10);
      if (shapeIndex >= 0 && shapeIndex < 4) {
        const order = parseInt(match[3], 10);
        const which = match[2] === 'init' ? 'init' : 'perFrame';
        shapeCode[shapeIndex][which].push({ order, text: value });
      }
      continue;
    }

    /* --- custom wave settings: wavecode_0_enabled ----------------------- */
    match = /^wavecode_(\d+)_(.+)$/.exec(lowerKey);
    if (match) {
      const waveIndex = parseInt(match[1], 10);
      if (waveIndex >= 0 && waveIndex < 4) {
        applyWaveSetting(preset.waves[waveIndex], match[2], value);
      }
      continue;
    }

    /* --- custom shape settings: shapecode_0_sides ----------------------- */
    match = /^shapecode_(\d+)_(.+)$/.exec(lowerKey);
    if (match) {
      const shapeIndex = parseInt(match[1], 10);
      if (shapeIndex >= 0 && shapeIndex < 4) {
        applyShapeSetting(preset.shapes[shapeIndex], match[2], value);
      }
      continue;
    }

    /* --- plain scalar --------------------------------------------------- */
    const spec = VAR_BY_KEY.get(lowerKey);
    if (spec) {
      const num = parseFloat(value);
      if (Number.isFinite(num)) {
        preset.baseVals[spec.key] = num;
      } else {
        preset.warnings.push(`${key}: could not read "${value.trim()}" as a number`);
      }
      continue;
    }

    // Unknown key. Keep it so a save doesn't lose it.
    preset.extra[key] = value;
  }

  preset.perFrameInit = assemble(buckets.perFrameInit);
  preset.perFrame = assemble(buckets.perFrame);
  preset.perPixel = assemble(buckets.perPixel);
  preset.warpShader = assemble(buckets.warp);
  preset.compShader = assemble(buckets.comp);

  for (let i = 0; i < 4; i++) {
    preset.waves[i].init = assemble(waveCode[i].init);
    preset.waves[i].perFrame = assemble(waveCode[i].perFrame);
    preset.waves[i].perPoint = assemble(waveCode[i].perPoint);
    preset.shapes[i].init = assemble(shapeCode[i].init);
    preset.shapes[i].perFrame = assemble(shapeCode[i].perFrame);
  }

  if (!preset.perFrame && !preset.perPixel && !preset.warpShader && !preset.compShader) {
    preset.warnings.push('No equations or shaders found - is this really a .milk preset?');
  }

  return preset;
}

function applyWaveSetting(wave: CustomWave, field: string, value: string): void {
  const num = parseFloat(value);
  const n = Number.isFinite(num) ? num : 0;
  switch (field) {
    case 'enabled':
      wave.enabled = n !== 0;
      break;
    case 'samples':
      wave.samples = Math.max(2, Math.min(Math.round(n) || 512, 512));
      break;
    case 'sep':
      wave.sep = n;
      break;
    case 'bspectrum':
      wave.spectrum = n !== 0;
      break;
    case 'busedots':
      wave.useDots = n !== 0;
      break;
    case 'bdrawthick':
      wave.drawThick = n !== 0;
      break;
    case 'badditive':
      wave.additive = n !== 0;
      break;
    case 'scaling':
      wave.scaling = n;
      break;
    case 'smoothing':
      wave.smoothing = n;
      break;
    case 'r':
      wave.r = n;
      break;
    case 'g':
      wave.g = n;
      break;
    case 'b':
      wave.b = n;
      break;
    case 'a':
      wave.a = n;
      break;
    default:
      break;
  }
}

function applyShapeSetting(shape: CustomShape, field: string, value: string): void {
  const num = parseFloat(value);
  const n = Number.isFinite(num) ? num : 0;
  switch (field) {
    case 'enabled':
      shape.enabled = n !== 0;
      break;
    case 'sides':
      shape.sides = Math.max(3, Math.min(Math.round(n) || 4, 100));
      break;
    case 'additive':
      shape.additive = n !== 0;
      break;
    case 'thickoutline':
      shape.thickOutline = n !== 0;
      break;
    case 'textured':
      shape.textured = n !== 0;
      break;
    case 'num_inst':
      shape.numInstances = Math.max(1, Math.min(Math.round(n) || 1, 1024));
      break;
    case 'x':
      shape.x = n;
      break;
    case 'y':
      shape.y = n;
      break;
    case 'rad':
      shape.rad = n;
      break;
    case 'ang':
      shape.ang = n;
      break;
    case 'tex_ang':
      shape.texAng = n;
      break;
    case 'tex_zoom':
      shape.texZoom = n;
      break;
    case 'r':
      shape.r = n;
      break;
    case 'g':
      shape.g = n;
      break;
    case 'b':
      shape.b = n;
      break;
    case 'a':
      shape.a = n;
      break;
    case 'r2':
      shape.r2 = n;
      break;
    case 'g2':
      shape.g2 = n;
      break;
    case 'b2':
      shape.b2 = n;
      break;
    case 'a2':
      shape.a2 = n;
      break;
    case 'border_r':
      shape.borderR = n;
      break;
    case 'border_g':
      shape.borderG = n;
      break;
    case 'border_b':
      shape.borderB = n;
      break;
    case 'border_a':
      shape.borderA = n;
      break;
    default:
      break;
  }
}

/* ------------------------------ writing -------------------------------- */

function formatValue(value: number, type: 'float' | 'int' | 'bool'): string {
  if (type === 'int' || type === 'bool') return String(Math.round(value));
  // MilkDrop writes 3 decimals; matching keeps diffs against originals small.
  return value.toFixed(3);
}

function writeNumbered(out: string[], prefix: string, code: string, backtick = false): void {
  if (!code.trim()) return;
  const lines = code.split('\n');
  lines.forEach((line, i) => {
    out.push(`${prefix}${i + 1}=${backtick ? '`' : ''}${line}`);
  });
}

/**
 * Serialise back to .milk. The output is a valid preset that MilkDrop itself
 * (and this app) can reload, which is what makes "tweak and save" real rather
 * than a session-only edit.
 */
export function serializeMilk(preset: MilkPreset): string {
  const out: string[] = ['[preset00]'];

  for (const spec of PRESET_VARS) {
    const value = preset.baseVals[spec.key];
    if (value === undefined) continue;
    out.push(`${spec.key}=${formatValue(value, spec.type)}`);
  }

  for (const [key, value] of Object.entries(preset.extra)) {
    out.push(`${key}=${value}`);
  }

  // Custom waves.
  preset.waves.forEach((wave, i) => {
    const p = `wavecode_${i}_`;
    out.push(`${p}enabled=${wave.enabled ? 1 : 0}`);
    out.push(`${p}samples=${wave.samples}`);
    out.push(`${p}sep=${Math.round(wave.sep)}`);
    out.push(`${p}bSpectrum=${wave.spectrum ? 1 : 0}`);
    out.push(`${p}bUseDots=${wave.useDots ? 1 : 0}`);
    out.push(`${p}bDrawThick=${wave.drawThick ? 1 : 0}`);
    out.push(`${p}bAdditive=${wave.additive ? 1 : 0}`);
    out.push(`${p}scaling=${wave.scaling.toFixed(5)}`);
    out.push(`${p}smoothing=${wave.smoothing.toFixed(5)}`);
    out.push(`${p}r=${wave.r.toFixed(3)}`);
    out.push(`${p}g=${wave.g.toFixed(3)}`);
    out.push(`${p}b=${wave.b.toFixed(3)}`);
    out.push(`${p}a=${wave.a.toFixed(3)}`);
  });

  // Custom shapes.
  preset.shapes.forEach((shape, i) => {
    const p = `shapecode_${i}_`;
    out.push(`${p}enabled=${shape.enabled ? 1 : 0}`);
    out.push(`${p}sides=${shape.sides}`);
    out.push(`${p}additive=${shape.additive ? 1 : 0}`);
    out.push(`${p}thickOutline=${shape.thickOutline ? 1 : 0}`);
    out.push(`${p}textured=${shape.textured ? 1 : 0}`);
    out.push(`${p}num_inst=${shape.numInstances}`);
    out.push(`${p}x=${shape.x.toFixed(3)}`);
    out.push(`${p}y=${shape.y.toFixed(3)}`);
    out.push(`${p}rad=${shape.rad.toFixed(5)}`);
    out.push(`${p}ang=${shape.ang.toFixed(5)}`);
    out.push(`${p}tex_ang=${shape.texAng.toFixed(5)}`);
    out.push(`${p}tex_zoom=${shape.texZoom.toFixed(5)}`);
    out.push(`${p}r=${shape.r.toFixed(3)}`);
    out.push(`${p}g=${shape.g.toFixed(3)}`);
    out.push(`${p}b=${shape.b.toFixed(3)}`);
    out.push(`${p}a=${shape.a.toFixed(3)}`);
    out.push(`${p}r2=${shape.r2.toFixed(3)}`);
    out.push(`${p}g2=${shape.g2.toFixed(3)}`);
    out.push(`${p}b2=${shape.b2.toFixed(3)}`);
    out.push(`${p}a2=${shape.a2.toFixed(3)}`);
    out.push(`${p}border_r=${shape.borderR.toFixed(3)}`);
    out.push(`${p}border_g=${shape.borderG.toFixed(3)}`);
    out.push(`${p}border_b=${shape.borderB.toFixed(3)}`);
    out.push(`${p}border_a=${shape.borderA.toFixed(3)}`);
  });

  preset.waves.forEach((wave, i) => {
    writeNumbered(out, `wave_${i}_init`, wave.init);
    writeNumbered(out, `wave_${i}_per_frame`, wave.perFrame);
    writeNumbered(out, `wave_${i}_per_point`, wave.perPoint);
  });
  preset.shapes.forEach((shape, i) => {
    writeNumbered(out, `shape_${i}_init`, shape.init);
    writeNumbered(out, `shape_${i}_per_frame`, shape.perFrame);
  });

  writeNumbered(out, 'per_frame_init_', preset.perFrameInit);
  writeNumbered(out, 'per_frame_', preset.perFrame);
  writeNumbered(out, 'per_pixel_', preset.perPixel);
  writeNumbered(out, 'warp_', preset.warpShader, true);
  writeNumbered(out, 'comp_', preset.compShader, true);

  return `${out.join('\r\n')}\r\n`;
}
