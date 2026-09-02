/**
 * MilkDrop preset generator.
 *
 * Run with: npm run gen:presets
 *
 * Writes .milk files into resources/milk/<Family>/. The output is committed, so
 * this script exists to *regenerate* or extend the library, not as a build step.
 *
 * Why generate rather than hand-write a hundred files? Because a preset is
 * mostly structure plus constants. The structure - what the warp shader does,
 * how per-pixel motion is derived, which decorations are used - is what makes
 * two presets look genuinely different, and there are only so many distinct
 * structures worth having. So the fourteen ARCHETYPES below are hand-authored
 * with real intent, and the variation axes then explore palette, motion
 * direction, audio routing and decay within each. That yields a library with
 * fourteen recognisable families rather than a hundred unrelated one-offs,
 * which is also how real MilkDrop preset packs are organised.
 *
 * Every generated preset is exercised by the smoke test, which loads each one,
 * checks it compiles clean and confirms it renders a non-blank frame.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_ROOT = path.join(ROOT, 'resources', 'milk');

/* ------------------------------ variation ------------------------------- */

/** Deterministic PRNG so regenerating produces identical files. */
function makeRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 4294967296;
  };
}

const BANDS = ['bass_att', 'mid_att', 'treb_att'];

/** Colour identities, chosen as trios that stay readable after tone mapping. */
const PALETTES = [
  { name: 'ember', r: [1.0, 0.45, 0.12], g: [1.0, 0.75, 0.30], b: [0.55, 0.10, 0.05] },
  { name: 'ice', r: [0.35, 0.75, 1.00], g: [0.60, 0.90, 1.00], b: [0.15, 0.35, 0.85] },
  { name: 'toxic', r: [0.35, 1.00, 0.40], g: [0.85, 1.00, 0.25], b: [0.10, 0.45, 0.20] },
  { name: 'orchid', r: [0.85, 0.35, 1.00], g: [1.00, 0.45, 0.80], b: [0.45, 0.15, 0.90] },
  { name: 'sodium', r: [1.00, 0.85, 0.35], g: [1.00, 0.60, 0.15], b: [0.35, 0.20, 0.05] },
  { name: 'abyss', r: [0.15, 0.35, 0.80], g: [0.25, 0.65, 0.85], b: [0.55, 0.30, 0.95] },
  { name: 'rose', r: [1.00, 0.40, 0.55], g: [1.00, 0.70, 0.75], b: [0.60, 0.25, 0.40] },
  { name: 'mint', r: [0.30, 0.95, 0.75], g: [0.75, 1.00, 0.85], b: [0.20, 0.60, 0.70] },
];

/**
 * Cap decay, and scale additive input against it.
 *
 * A feedback buffer with decay d accumulates injected energy to roughly
 * input/(1-d). At d=0.992 that is a 125x gain, so even a modest additive
 * waveform saturates the buffer to a flat wash within a couple of seconds.
 * Keeping the product of decay headroom and injection roughly constant is what
 * stops a family from blowing out while still allowing long trails.
 */
const MAX_DECAY = 0.985;

function safeDecay(value) {
  return Math.min(value, MAX_DECAY);
}

/**
 * Additive brightness a preset can afford at this decay.
 *
 * The floor matters as much as the cap. Presets whose only light source is the
 * waveform go completely black if the injection is scaled down too far, so the
 * scaling stops well short of zero even at maximum decay.
 */
function injectionScale(decay) {
  const headroom = 1 - safeDecay(decay);
  return Math.min(1.15, Math.max(0.55, headroom / 0.04));
}

/**
 * Waveform alpha, floored.
 *
 * `bModWaveAlphaByVolume` attenuates again at runtime, so stacking it on top of
 * an already-scaled alpha is what drove three families to black. Families that
 * rely on the wave for all their light keep the volume gate off and take this
 * floor instead.
 */
function waveAlphaFor(v, scale = 1) {
  return Math.max(0.45, v.waveAlpha * scale);
}

function variantAxes(index, random) {
  const palette = PALETTES[index % PALETTES.length];
  const decay = safeDecay(0.93 + random() * 0.05);
  const inject = injectionScale(decay);
  return {
    palette,
    band: BANDS[index % BANDS.length],
    band2: BANDS[(index + 1) % BANDS.length],
    speed: 0.55 + random() * 1.15,
    // Half the variants move inward, half outward - the single biggest
    // difference in how a feedback preset reads.
    zoomDir: index % 2 === 0 ? 1 : -1,
    rotDir: index % 3 === 0 ? -1 : 1,
    decay,
    inject,
    symmetry: 3 + (index % 6),
    waveMode: index % 8,
    waveAlpha: (0.3 + random() * 0.8) * inject,
    warpScale: 0.7 + random() * 2.0,
    hue: random(),
  };
}

const f = (n, digits = 4) => Number(n).toFixed(digits);

/** Per-frame colour equations, so every family gets a moving palette. */
function paletteEquations(v, speedScale = 1) {
  const s = f(0.17 * v.speed * speedScale, 4);
  return [
    `hue = time * ${s} + ${f(v.hue * 6.283, 3)};`,
    `wave_r = ${f(v.palette.r[0], 3)} * (0.55 + 0.45 * sin(hue));`,
    `wave_g = ${f(v.palette.g[0], 3)} * (0.55 + 0.45 * sin(hue + 2.09));`,
    `wave_b = ${f(v.palette.b[0], 3)} * (0.55 + 0.45 * sin(hue + 4.19));`,
  ];
}

/** q1..q4 carry audio and time into the shaders; every archetype sets them. */
function commonQ(v) {
  return [
    `q1 = ${v.band};`,
    `q2 = ${v.band2};`,
    'q3 = treb_att;',
    'q4 = time;',
  ];
}

/* ------------------------------ archetypes ------------------------------ */

/**
 * Each archetype is a distinct visual family. `build(v)` returns the pieces of
 * a preset; anything omitted falls back to a sensible default.
 */
const ARCHETYPES = [
  {
    family: 'Tunnels',
    names: ['Event Horizon', 'Wormhole', 'The Descent', 'Long Fall', 'Singularity',
            'Corridor', 'Vanishing Point', 'Throat'],
    build: (v) => ({
      base: {
        zoom: 1 + v.zoomDir * 0.02, fZoomExponent: 1.6 + v.symmetry * 0.12,
        fDecay: v.decay, warp: 0.05, nWaveMode: 6, fWaveAlpha: v.waveAlpha * 0.6,
        bTexWrap: 0, fVideoEchoAlpha: 0,
      },
      perFrame: [
        ...commonQ(v),
        `zoom = ${f(1 + v.zoomDir * 0.012)} + ${f(v.zoomDir * 0.030)} * q1;`,
        `rot = ${f(v.rotDir * 0.004 * v.speed)} * sin(time * ${f(0.09 * v.speed)});`,
        `decay = ${f(v.decay)} + 0.012 * q3;`,
        `cx = 0.5 + ${f(0.035 * v.speed)} * sin(time * ${f(0.043 * v.speed)});`,
        `cy = 0.5 + ${f(0.035 * v.speed)} * cos(time * ${f(0.037 * v.speed)});`,
        ...paletteEquations(v),
      ],
      perPixel: [
        `zoomexp = ${f(1.5 + v.symmetry * 0.14)} + 0.7 * q1;`,
        `zoom = zoom + ${f(v.zoomDir * 0.014)} * (1 - rad) * q1;`,
      ],
      warp: [
        'float2 d = uv - 0.5;',
        'float r = length(d) + 0.0001;',
        'float2 dir = d / r;',
        `float sep = ${f(0.0011 * v.speed, 5)} * (0.3 + q3);`,
        'float3 col;',
        'col.x = tex2D(sampler_main, uv + dir * sep).x;',
        'col.y = tex2D(sampler_main, uv).y;',
        'col.z = tex2D(sampler_main, uv - dir * sep).z;',
        'ret = col * decay;',
      ],
      comp: [
        'float3 base = tex2D(sampler_main, uv).xyz;',
        'float3 bloom = GetBlur2(uv) * 0.45 + GetBlur3(uv) * 0.65;',
        `float3 col = base + bloom * (${f(0.20 + v.hue * 0.2, 3)} + q1 * 0.4);`,
        'float r = length(uv - 0.5);',
        'col *= 1.0 - saturate(r * r * 1.3);',
        'ret = col;',
      ],
    }),
  },

  {
    family: 'Vortex',
    names: ['Maelstrom', 'Undertow', 'Shear Line', 'Cyclone', 'Drain',
            'Spin Cycle', 'Coriolis', 'Whirl'],
    build: (v) => ({
      base: {
        zoom: 1.002, fDecay: v.decay, warp: 0.3, rot: 0.01 * v.rotDir,
        nWaveMode: v.waveMode, fWaveAlpha: v.waveAlpha, bAdditiveWaves: 1,
        fVideoEchoAlpha: 0.15,
      },
      perFrame: [
        ...commonQ(v),
        `zoom = 1.001 + ${f(v.zoomDir * 0.010)} * q1;`,
        `rot = ${f(v.rotDir * 0.012 * v.speed)} + ${f(v.rotDir * 0.014)} * sin(time * ${f(0.13 * v.speed)});`,
        `warp = 0.15 + 0.45 * q2;`,
        `decay = ${f(v.decay)};`,
        ...paletteEquations(v),
      ],
      perPixel: [
        // Rotation that falls off with radius is what shears the image into a
        // spiral instead of turning it rigidly.
        `rot = rot + ${f(v.rotDir * 0.060 * v.speed)} * (1 - rad) * q1;`,
        `zoom = zoom + 0.006 * sin(ang * ${v.symmetry} + time * ${f(0.9 * v.speed)}) * q2;`,
      ],
      warp: [
        'float2 d = uv - 0.5;',
        'float r = length(d) + 0.0001;',
        `float swirl = ${f(0.014 * v.speed * v.rotDir, 5)} * (1.0 - r) * (0.4 + q1);`,
        'float s = sin(swirl);',
        'float c = cos(swirl);',
        'float2 uv2 = float2(d.x * c - d.y * s, d.x * s + d.y * c) + 0.5;',
        'ret = tex2D(sampler_main, uv2).xyz * decay;',
      ],
    }),
  },

  {
    family: 'Ripples',
    names: ['Still Water', 'Rain Gauge', 'Interference', 'Meniscus', 'Pond Skater',
            'Standing Wave', 'Capillary', 'Tide Pool'],
    build: (v) => ({
      base: {
        zoom: 1.0, fDecay: v.decay, warp: 0.1, nWaveMode: 0,
        fWaveAlpha: v.waveAlpha, bAdditiveWaves: 1, fVideoEchoAlpha: 0.1,
        bDarkenCenter: 0,
      },
      perFrame: [
        ...commonQ(v),
        `zoom = 0.9995 + ${f(v.zoomDir * 0.006)} * q1;`,
        `rot = ${f(v.rotDir * 0.003)} * sin(time * ${f(0.11 * v.speed)});`,
        `decay = ${f(v.decay)} + 0.02 * q3;`,
        ...paletteEquations(v),
      ],
      perPixel: [`zoom = zoom + 0.004 * cos(rad * ${f(7 + v.symmetry)} - time * ${f(1.3 * v.speed)});`],
      warp: [
        'float2 d = uv - 0.5;',
        'float r = length(d) + 0.0001;',
        // Displacing along the radius by a travelling sine is the ripple.
        `float ripple = sin(r * ${f(18 + v.symmetry * 3, 2)} - time * ${f(1.7 * v.speed)} + q1 * 5.0);`,
        `float2 uv2 = uv + (d / r) * ripple * ${f(0.0022 * v.speed, 5)} * (0.35 + q1);`,
        'float3 col = tex2D(sampler_main, uv2).xyz;',
        'ret = col * decay;',
      ],
      comp: [
        'float3 base = tex2D(sampler_main, uv).xyz;',
        'float3 b1 = GetBlur1(uv);',
        'float3 highlight = saturate((base - GetBlur3(uv)) * 2.2);',
        `ret = base + b1 * 0.18 + highlight * (0.25 + q3 * 0.5);`,
      ],
    }),
  },

  {
    family: 'Bloom',
    names: ['Soft Focus', 'Halation', 'Overexposed', 'Gauze', 'Lens Flare',
            'Diffusion', 'Glow Worm', 'Bokeh'],
    build: (v) => ({
      base: {
        zoom: 1.003, fDecay: safeDecay(v.decay + 0.03), warp: 0.25,
        nWaveMode: v.waveMode, fWaveAlpha: waveAlphaFor(v, 1.3), bAdditiveWaves: 1,
        bModWaveAlphaByVolume: 0, fVideoEchoAlpha: 0,
      },
      perFrame: [
        ...commonQ(v),
        `zoom = 1.0015 + ${f(v.zoomDir * 0.008)} * q1;`,
        `rot = ${f(v.rotDir * 0.005)} * sin(time * ${f(0.08 * v.speed)});`,
        `warp = 0.15 + 0.35 * q2;`,
        `decay = ${f(safeDecay(v.decay + 0.03))};`,
        ...paletteEquations(v),
      ],
      perPixel: [`zoom = zoom + 0.003 * sin(rad * ${f(5 + v.symmetry)} + time * ${f(0.6 * v.speed)});`],
      comp: [
        'float3 base = tex2D(sampler_main, uv).xyz;',
        `float3 bloom = GetBlur1(uv) * ${f(0.3 + v.hue * 0.2, 3)}`,
        `             + GetBlur2(uv) * 0.5`,
        `             + GetBlur3(uv) * 0.7;`,
        `float3 col = base + bloom * (0.30 + q1 * ${f(0.4 + v.hue * 0.3, 3)});`,
        'float r = length(uv - 0.5);',
        'col *= 1.0 - saturate(r * r * 1.0);',
        'ret = pow(saturate(col), float3(0.92, 0.94, 0.96));',
      ],
    }),
  },

  {
    family: 'Chrome',
    names: ['Mercury', 'Cold Rolled', 'Foil', 'Quicksilver', 'Bearing Surface',
            'Anodised', 'Machined', 'Alloy'],
    build: (v) => ({
      base: {
        zoom: 1.001, fDecay: safeDecay(v.decay + 0.04), warp: 0.6,
        nWaveMode: 1, fWaveAlpha: v.waveAlpha * 0.7, bWaveThick: 1,
        fWarpScale: v.warpScale, fGammaAdj: 1.0,
      },
      perFrame: [
        ...commonQ(v),
        `zoom = 1.0005 + ${f(v.zoomDir * 0.006)} * q1;`,
        `rot = ${f(v.rotDir * 0.003)} * sin(time * ${f(0.09 * v.speed)});`,
        'warp = 0.35 + 0.45 * q2;',
        `decay = ${f(safeDecay(v.decay + 0.04))};`,
        ...paletteEquations(v, 0.6),
      ],
      perPixel: [`zoom = zoom + 0.003 * sin(rad * ${f(4 + v.symmetry)} + time * ${f(0.5 * v.speed)});`],
      warp: [
        'float2 d = uv - 0.5;',
        'float r = length(d) + 0.0001;',
        `float ripple = sin(r * ${f(20 + v.symmetry * 2, 2)} - time * ${f(1.5 * v.speed)} + q1 * 4.0) * ${f(0.0015 * v.speed, 5)};`,
        'float2 uv2 = uv + (d / r) * ripple * (0.4 + q1);',
        'float3 col = tex2D(sampler_main, uv2).xyz;',
        // Pushing colour toward a luminance ramp is what reads as metal.
        'float l = lum(col);',
        `float3 metal = lerp(float3(0.04, 0.05, 0.09), float3(${f(v.palette.r[1], 2)}, ${f(v.palette.g[1], 2)}, ${f(v.palette.b[1] + 0.5, 2)}), l);`,
        'col = lerp(col, metal, 0.12);',
        'ret = col * decay;',
      ],
      comp: [
        'float3 base = tex2D(sampler_main, uv).xyz;',
        'float3 highlight = saturate((base - GetBlur3(uv)) * 2.5);',
        `ret = base + GetBlur1(uv) * 0.18 + highlight * (0.3 + q3 * 0.5);`,
      ],
    }),
  },

  {
    family: 'Nebula',
    names: ['Cold Dust', 'Stellar Nursery', 'Dark Cloud', 'Ion Trail', 'Pillars',
            'Deep Field', 'Gas Giant', 'Halo'],
    build: (v) => ({
      base: {
        zoom: 1 + v.zoomDir * 0.012, fDecay: safeDecay(v.decay + 0.05),
        warp: 0.04, nWaveMode: 6, fWaveAlpha: waveAlphaFor(v, 0.9), bWaveDots: 1,
        bAdditiveWaves: 1, bTexWrap: 0, fZoomExponent: 1.8,
      },
      perFrame: [
        ...commonQ(v),
        `zoom = ${f(1 + v.zoomDir * 0.008)} + ${f(v.zoomDir * 0.020)} * q1;`,
        `rot = ${f(v.rotDir * 0.002)} * sin(time * ${f(0.05 * v.speed)});`,
        `decay = ${f(safeDecay(v.decay + 0.05))};`,
        ...paletteEquations(v, 0.4),
      ],
      perPixel: [
        `zoomexp = ${f(1.6 + v.symmetry * 0.1)} + 0.6 * q1;`,
        'zoom = zoom + 0.008 * (1 - rad) * q1;',
      ],
      comp: [
        'float3 base = tex2D(sampler_main, uv).xyz;',
        `float3 bloom = GetBlur2(uv) * ${f(0.30 * v.inject, 3)} + GetBlur3(uv) * ${f(0.45 * v.inject, 3)};`,
        `float3 col = base + bloom * (${f(0.16 * v.inject, 3)} + q2 * ${f(0.22 * v.inject, 3)});`,
        // Split-toning by luminance is what gives depth to a flat glow.
        'float l = lum(col);',
        `float3 shadow = float3(${f(v.palette.b[0], 2)}, ${f(v.palette.b[1], 2)}, ${f(Math.min(v.palette.b[2] + 0.4, 1), 2)});`,
        `float3 light = float3(${f(v.palette.r[0], 2)}, ${f(v.palette.g[1], 2)}, ${f(v.palette.b[1], 2)});`,
        'col *= lerp(shadow, light, saturate(l * 1.7));',
        'float r = length(uv - 0.5);',
        'col *= 1.0 - saturate(r * r * 1.5);',
        'ret = col;',
      ],
    }),
  },

  {
    family: 'Lattice',
    names: ['Warp and Weft', 'Chain Link', 'Graph Paper', 'Truss', 'Basket',
            'Circuit', 'Mesh Screen', 'Quilt'],
    build: (v) => ({
      base: {
        zoom: 0.999, fDecay: v.decay, warp: 0.03, nWaveMode: 4,
        fWaveAlpha: v.waveAlpha, bAdditiveWaves: 1, bTexWrap: 0,
        ob_size: 0.006, ob_a: 0.5, ib_size: 0.003, ib_a: 0.3,
      },
      perFrame: [
        ...commonQ(v),
        `zoom = 0.9985 + ${f(v.zoomDir * 0.010)} * q1;`,
        `dx = ${f(0.0009 * v.speed)} * sin(time * ${f(0.4 * v.speed)});`,
        `dy = ${f(0.0009 * v.speed)} * cos(time * ${f(0.33 * v.speed)});`,
        `decay = ${f(v.decay)} + 0.03 * q2;`,
        ...paletteEquations(v),
        `ib_r = wave_r; ib_g = wave_g; ib_b = wave_b;`,
      ],
      perPixel: [
        // Independent x and y displacement produces a woven, orthogonal look.
        `zoom = zoom + 0.005 * sin(x * ${f(12 + v.symmetry * 2, 1)} + time * ${f(1.1 * v.speed)}) * cos(y * ${f(12 + v.symmetry * 2, 1)} - time * ${f(0.9 * v.speed)}) * q2;`,
      ],
    }),
  },

  {
    family: 'Kaleido',
    names: ['Rose Window', 'Snowflake', 'Mandala', 'Cathedral', 'Fold Symmetry',
            'Prayer Wheel', 'Sixfold', 'Stained Glass'],
    build: (v) => ({
      base: {
        zoom: 1.0, fDecay: v.decay, warp: 0.5, nWaveMode: 3,
        fWaveAlpha: v.waveAlpha, bAdditiveWaves: 1, bWaveThick: 1,
        fVideoEchoAlpha: 0.3, nVideoEchoOrientation: v.symmetry % 4,
        fWarpScale: v.warpScale,
      },
      perFrame: [
        ...commonQ(v),
        `zoom = 0.999 + ${f(v.zoomDir * 0.008)} * q1;`,
        `rot = ${f(v.rotDir * 0.014)} * sin(time * ${f(0.21 * v.speed)});`,
        'warp = 0.30 + 0.55 * q2;',
        `decay = ${f(v.decay)};`,
        ...paletteEquations(v),
      ],
      perPixel: [
        // Quantising the angle into wedges before using it is the fold.
        `wedge = int(ang / ${f(6.2832 / v.symmetry, 4)});`,
        `rot = rot + ${f(0.045 * v.rotDir)} * sin(wedge * ${f(6.2832 / v.symmetry, 4)} * 3 + time) * q2;`,
        `zoom = zoom + 0.007 * cos(rad * ${f(8 + v.symmetry)} - time * ${f(1.4 * v.speed)}) * q1;`,
        `warp = warp * (1 + 0.6 * sin(ang * ${v.symmetry}));`,
      ],
    }),
  },

  {
    family: 'Orbits',
    names: ['Clockwork', 'Ephemeris', 'Swarm', 'Satellites', 'Rosette',
            'Epicycle', 'Constellation', 'Carousel'],
    build: (v) => ({
      base: {
        zoom: 1.004, fDecay: v.decay, warp: 0.15, rot: 0.008 * v.rotDir,
        nWaveMode: 1, fWaveAlpha: v.waveAlpha * 0.5, bWaveDots: 1,
        bAdditiveWaves: 1, fVideoEchoAlpha: 0.2,
        nVideoEchoOrientation: v.symmetry % 4,
      },
      perFrame: [
        ...commonQ(v),
        `zoom = 1.003 + ${f(v.zoomDir * 0.012)} * q1;`,
        `rot = ${f(v.rotDir * 0.006)} + ${f(v.rotDir * 0.008)} * sin(time * ${f(0.19 * v.speed)});`,
        `decay = ${f(v.decay)};`,
        ...paletteEquations(v),
      ],
      perPixel: [`rot = rot + ${f(0.02 * v.rotDir)} * (0.5 - rad) * q2;`],
      shapes: [
        {
          index: 0,
          enabled: 1, sides: v.symmetry, additive: 1, thickOutline: 1,
          numInstances: 6 + (v.symmetry % 6),
          rad: 0.08, a: 0.4, a2: 0, borderA: 0.4,
          r: v.palette.r[0], g: v.palette.g[0], b: v.palette.b[0],
          r2: v.palette.r[2], g2: v.palette.g[2], b2: v.palette.b[2],
          perFrame: [
            `orbit = q4 * ${f(0.35 * v.speed)} * ${v.rotDir} + instance * ${f(6.2832 / (6 + (v.symmetry % 6)), 4)};`,
            `dist = ${f(0.12 + v.hue * 0.10)} + ${f(0.10)} * sin(q4 * ${f(0.4 * v.speed)} + instance);`,
            'x = 0.5 + cos(orbit) * dist * 0.8;',
            'y = 0.5 + sin(orbit) * dist;',
            `rad = ${f(0.020 + v.hue * 0.02)} + ${f(0.04)} * q1 + instance * 0.0015;`,
            'ang = orbit * 1.7;',
            `r = ${f(v.palette.r[0], 3)} * (0.5 + 0.5 * sin(instance * 0.9 + q4 * 0.5));`,
            `g = ${f(v.palette.g[0], 3)} * (0.5 + 0.5 * sin(instance * 0.9 + q4 * 0.5 + 2.1));`,
            `b = ${f(v.palette.b[0], 3)} * (0.5 + 0.5 * sin(instance * 0.9 + q4 * 0.5 + 4.2));`,
            'a = 0.25 + 0.35 * q1;',
            'border_a = 0.20 + 0.35 * q3;',
          ],
        },
      ],
    }),
  },

  {
    family: 'Waveforms',
    names: ['Oscillograph', 'Lissajous', 'Trace', 'Signal Path', 'Envelope',
            'Ribbon Cable', 'Sine Bank', 'Phase Plot'],
    build: (v) => ({
      base: {
        zoom: 0.9985, fDecay: v.decay - 0.02, warp: 0.02,
        nWaveMode: v.waveMode, fWaveAlpha: 0.2, bTexWrap: 0,
        fVideoEchoAlpha: 0.2, nVideoEchoOrientation: 1,
        ob_size: 0.008, ob_a: 0.6, ib_size: 0.004, ib_a: 0.35,
      },
      perFrame: [
        ...commonQ(v),
        `zoom = 0.998 + ${f(v.zoomDir * 0.006)} * q1;`,
        `rot = ${f(v.rotDir * 0.008)} * sin(time * ${f(0.27 * v.speed)});`,
        `decay = ${f(Math.max(v.decay - 0.02, 0.90))};`,
        ...paletteEquations(v),
        'ib_r = wave_r; ib_g = wave_g; ib_b = wave_b;',
      ],
      perPixel: [`zoom = zoom + 0.003 * sin(x * ${f(8 + v.symmetry)} + time) * cos(y * ${f(8 + v.symmetry)} - time);`],
      waves: [
        {
          index: 0, enabled: 1, samples: 440, thick: 1, additive: 1,
          scaling: 1.2 + v.hue, smoothing: 0.6,
          r: v.palette.r[0], g: v.palette.g[0], b: v.palette.b[0], a: 0.85,
          perFrame: [`t1 = q4 * ${f(0.3 * v.speed)};`],
          perPoint: [
            `k = sample * 6.2832 * ${1 + (v.symmetry % 4)} + t1;`,
            `fold = ${f(0.18 + v.hue * 0.12)} + ${f(0.14)} * sin(k * 2) + value1 * ${f(0.20 + v.hue * 0.1)};`,
            'x = 0.5 + cos(k) * fold * 0.75;',
            'y = 0.5 + sin(k) * fold;',
            `r = ${f(v.palette.r[0], 3)} * (0.45 + 0.55 * abs(value1));`,
            `g = ${f(v.palette.g[0], 3)} * (0.5 + 0.5 * sin(k * 0.5));`,
            `b = ${f(v.palette.b[0], 3)} * (0.5 + 0.5 * cos(k * 0.5));`,
          ],
        },
        {
          index: 1, enabled: 1, samples: 256, spectrum: 1, useDots: 1, additive: 1,
          scaling: 1.8 + v.hue, smoothing: 0.25, sep: 6,
          r: v.palette.r[1], g: v.palette.g[1], b: v.palette.b[1], a: 0.7,
          perPoint: [
            'x = 0.05 + sample * 0.90;',
            `y = 0.90 - value1 * ${f(0.45 + v.hue * 0.2)} * q3;`,
            `r = ${f(v.palette.r[1], 3)};`,
            `g = ${f(v.palette.g[1], 3)} * (0.4 + 0.6 * sample);`,
            `b = ${f(v.palette.b[1], 3)};`,
          ],
        },
      ],
    }),
  },

  {
    family: 'Flares',
    names: ['Coronal Mass', 'Prominence', 'Sunspot', 'Chromosphere', 'Plasma Arc',
            'Photosphere', 'Ignition', 'Blowtorch'],
    build: (v) => ({
      base: {
        zoom: 0.994, fDecay: v.decay, warp: 0.9, fZoomExponent: 0.7,
        nWaveMode: 2, fWaveAlpha: v.waveAlpha, bAdditiveWaves: 1, bWaveThick: 1,
        fVideoEchoAlpha: 0.2, fWarpScale: v.warpScale,
      },
      perFrame: [
        ...commonQ(v),
        `zoom = 0.9935 - 0.006 * q1;`,
        `rot = ${f(v.rotDir * 0.006)} + ${f(v.rotDir * 0.010)} * sin(time * ${f(0.19 * v.speed)});`,
        'warp = 0.55 + 0.75 * q2;',
        `decay = ${f(v.decay)};`,
        ...paletteEquations(v),
      ],
      perPixel: [
        'zoomexp = 0.6 + 0.3 * q1;',
        `rot = rot + ${f(0.03 * v.rotDir)} * rad * q2;`,
        `warp = warp * (1 + 0.8 * sin(ang * ${v.symmetry} + time * 2));`,
      ],
      warp: [
        'float2 d = uv - 0.5;',
        'float r = length(d) + 0.0001;',
        'float2 dir = d / r;',
        // Push accelerates with radius, so material appears ejected.
        `float2 uv2 = uv - dir * (${f(0.0016 * v.speed, 5)} + ${f(0.0032 * v.speed, 5)} * r) * (0.5 + q1);`,
        'float3 col = tex2D(sampler_main, uv2).xyz;',
        'float l = saturate(lum(col) * 1.4);',
        `float3 fire = lerp(float3(${f(v.palette.b[2] * 0.6, 3)}, 0.02, 0.0), float3(${f(v.palette.r[0], 2)}, ${f(v.palette.g[0], 2)}, ${f(v.palette.b[1], 2)}), l);`,
        'col = lerp(col, col * fire * 1.6, 0.24);',
        'ret = col * decay;',
      ],
      comp: [
        'float3 base = tex2D(sampler_main, uv).xyz;',
        `float3 bloom = GetBlur1(uv) * ${f(0.24 * v.inject, 3)} + GetBlur2(uv) * ${f(0.34 * v.inject, 3)} + GetBlur3(uv) * ${f(0.40 * v.inject, 3)};`,
        `float3 col = base + bloom * (${f(0.18 * v.inject, 3)} + q1 * ${f(0.28 * v.inject, 3)});`,
        'float r = length(uv - 0.5);',
        `col += float3(${f(v.palette.r[0], 2)}, ${f(v.palette.g[1], 2)}, ${f(v.palette.b[1], 2)}) * exp(-r * 9.0) * (${f(0.12 * v.inject, 3)} + q1 * ${f(0.34 * v.inject, 3)});`,
        'col *= 1.0 - saturate(r * r * 1.2);',
        'ret = col;',
      ],
    }),
  },

  {
    family: 'Echoes',
    names: ['Hall of Mirrors', 'Repeater', 'Reverb', 'Doppelganger', 'Cascade',
            'Delay Line', 'Feedback Loop', 'Second Voice'],
    build: (v) => ({
      base: {
        zoom: 1.0, fDecay: v.decay, warp: 0.2,
        fVideoEchoAlpha: 0.42, fVideoEchoZoom: 1.0 + v.zoomDir * 0.02,
        nVideoEchoOrientation: v.symmetry % 4,
        nWaveMode: v.waveMode, fWaveAlpha: v.waveAlpha, bAdditiveWaves: 1,
      },
      perFrame: [
        ...commonQ(v),
        `zoom = 0.9995 + ${f(v.zoomDir * 0.009)} * q1;`,
        `rot = ${f(v.rotDir * 0.010)} * sin(time * ${f(0.17 * v.speed)});`,
        `echo_alpha = 0.28 + 0.24 * q2;`,
        `echo_zoom = ${f(1 + v.zoomDir * 0.015)} + 0.02 * q1;`,
        `decay = ${f(v.decay)};`,
        ...paletteEquations(v),
      ],
      perPixel: [`zoom = zoom + 0.005 * sin(ang * ${v.symmetry} + time * ${f(0.7 * v.speed)}) * q1;`],
    }),
  },

  {
    family: 'Drift',
    names: ['Slow Current', 'Continental', 'Thermal', 'Lazy River', 'Sediment',
            'Trade Wind', 'Sargasso', 'Downstream'],
    build: (v) => ({
      base: {
        zoom: 1.0005, fDecay: safeDecay(v.decay + 0.035), warp: 0.45,
        fWarpAnimSpeed: 0.4 * v.speed, fWarpScale: v.warpScale + 1,
        nWaveMode: 0, fWaveAlpha: waveAlphaFor(v, 1.1), bAdditiveWaves: 1,
        bModWaveAlphaByVolume: 0,
      },
      perFrame: [
        ...commonQ(v),
        `zoom = 1.0002 + ${f(v.zoomDir * 0.005)} * q1;`,
        `dx = ${f(0.0016 * v.speed * v.rotDir)} * sin(time * ${f(0.07 * v.speed)});`,
        `dy = ${f(0.0016 * v.speed)} * cos(time * ${f(0.055 * v.speed)});`,
        'warp = 0.30 + 0.40 * q2;',
        `decay = ${f(safeDecay(v.decay + 0.035))};`,
        ...paletteEquations(v, 0.5),
      ],
      perPixel: [`zoom = zoom + 0.0025 * sin(rad * ${f(4 + v.symmetry)} + time * ${f(0.3 * v.speed)});`],
      warp: [
        'float2 d = uv - 0.5;',
        // Sampling low-frequency noise as a flow field gives an organic drift
        // that a pure sine warp cannot.
        `float2 n = tex2D(sampler_noise_lq, uv * ${f(0.6 + v.hue * 0.5, 3)} + time * ${f(0.01 * v.speed, 4)}).xy - 0.5;`,
        `float2 uv2 = uv + n * ${f(0.0035 * v.speed, 5)} * (0.4 + q1);`,
        'float3 col = tex2D(sampler_main, uv2).xyz;',
        'ret = col * decay;',
      ],
      comp: [
        'float3 base = tex2D(sampler_main, uv).xyz;',
        'float3 col = base + GetBlur2(uv) * (0.22 + q2 * 0.3);',
        'float r = length(uv - 0.5);',
        'col *= 1.0 - saturate(r * r * 1.1);',
        'ret = col;',
      ],
    }),
  },

  {
    family: 'Pulse',
    names: ['Four on the Floor', 'Metronome', 'Systole', 'Strobe', 'Downbeat',
            'Kick Drum', 'Heartbeat', 'Trigger'],
    build: (v) => ({
      base: {
        zoom: 1.0, fDecay: Math.max(v.decay - 0.03, 0.90), warp: 0.1,
        nWaveMode: v.waveMode, fWaveAlpha: v.waveAlpha * 1.3,
        bAdditiveWaves: 1, bWaveThick: 1, bDarkenCenter: 1,
        nMotionVectorsX: 12, nMotionVectorsY: 9, mv_a: 0.2,
      },
      perFrame: [
        ...commonQ(v),
        // A sharp power curve on the band turns a smooth level into a hit.
        'kick = pow(min(q1 * 0.75, 1.4), 3.0);',
        `zoom = ${f(1 + v.zoomDir * 0.004)} + ${f(v.zoomDir * 0.055)} * kick;`,
        `rot = ${f(v.rotDir * 0.02)} * kick;`,
        `decay = ${f(Math.max(v.decay - 0.03, 0.90))} + 0.04 * kick;`,
        'mv_a = 0.08 + 0.35 * q3;',
        `mv_r = wave_r; mv_g = wave_g; mv_b = wave_b;`,
        ...paletteEquations(v),
      ],
      perPixel: [`zoom = zoom + 0.010 * (1 - rad) * q1;`],
    }),
  },
];

/* ------------------------------ emitting -------------------------------- */

const DEFAULT_BASE = {
  fRating: 3, fGammaAdj: 1.2, fDecay: 0.96, fVideoEchoZoom: 1, fVideoEchoAlpha: 0,
  nVideoEchoOrientation: 0, nWaveMode: 0, bAdditiveWaves: 0, bWaveDots: 0,
  bWaveThick: 0, bModWaveAlphaByVolume: 0, bMaximizeWaveColor: 1, bTexWrap: 1,
  bDarkenCenter: 0, bRedBlueStereo: 0, bBrighten: 0, bDarken: 0, bSolarize: 0,
  bInvert: 0, fWaveAlpha: 0.8, fWaveScale: 1.2, fWaveSmoothing: 0.7,
  fWaveParam: 0, fModWaveAlphaStart: 0.7, fModWaveAlphaEnd: 1.3,
  fWarpAnimSpeed: 1, fWarpScale: 1.3, fZoomExponent: 1,
  nMotionVectorsX: 0, nMotionVectorsY: 0, mv_dx: 0, mv_dy: 0, mv_l: 0.9,
  mv_r: 1, mv_g: 1, mv_b: 1, mv_a: 0,
  b1n: 0, b2n: 0, b3n: 0, b1x: 1, b2x: 1, b3x: 1, b1ed: 0.25,
  zoom: 1, rot: 0, cx: 0.5, cy: 0.5, dx: 0, dy: 0, warp: 0.2, sx: 1, sy: 1,
  wave_r: 1, wave_g: 1, wave_b: 1, wave_x: 0.5, wave_y: 0.5,
  ob_size: 0, ob_r: 0, ob_g: 0, ob_b: 0, ob_a: 0,
  ib_size: 0, ib_r: 0.25, ib_g: 0.25, ib_b: 0.25, ib_a: 0,
};

const INT_KEYS = new Set([
  'nWaveMode', 'nVideoEchoOrientation', 'bAdditiveWaves', 'bWaveDots', 'bWaveThick',
  'bModWaveAlphaByVolume', 'bMaximizeWaveColor', 'bTexWrap', 'bDarkenCenter',
  'bRedBlueStereo', 'bBrighten', 'bDarken', 'bSolarize', 'bInvert',
]);

function numbered(prefix, lines, backtick = false) {
  if (!lines || lines.length === 0) return [];
  return lines.map((line, i) => `${prefix}${i + 1}=${backtick ? '`' : ''}${line}`);
}

function emitPreset(spec) {
  const base = { ...DEFAULT_BASE, ...spec.base };
  const out = ['[preset00]'];

  for (const [key, value] of Object.entries(base)) {
    out.push(`${key}=${INT_KEYS.has(key) ? Math.round(value) : Number(value).toFixed(3)}`);
  }

  for (const wave of spec.waves ?? []) {
    const p = `wavecode_${wave.index}_`;
    out.push(
      `${p}enabled=${wave.enabled ?? 1}`,
      `${p}samples=${wave.samples ?? 512}`,
      `${p}sep=${wave.sep ?? 0}`,
      `${p}bSpectrum=${wave.spectrum ?? 0}`,
      `${p}bUseDots=${wave.useDots ?? 0}`,
      `${p}bDrawThick=${wave.thick ?? 0}`,
      `${p}bAdditive=${wave.additive ?? 0}`,
      `${p}scaling=${Number(wave.scaling ?? 1).toFixed(5)}`,
      `${p}smoothing=${Number(wave.smoothing ?? 0.5).toFixed(5)}`,
      `${p}r=${Number(wave.r ?? 1).toFixed(3)}`,
      `${p}g=${Number(wave.g ?? 1).toFixed(3)}`,
      `${p}b=${Number(wave.b ?? 1).toFixed(3)}`,
      `${p}a=${Number(wave.a ?? 1).toFixed(3)}`,
    );
  }

  for (const shape of spec.shapes ?? []) {
    const p = `shapecode_${shape.index}_`;
    out.push(
      `${p}enabled=${shape.enabled ?? 1}`,
      `${p}sides=${shape.sides ?? 4}`,
      `${p}additive=${shape.additive ?? 0}`,
      `${p}thickOutline=${shape.thickOutline ?? 0}`,
      `${p}textured=0`,
      `${p}num_inst=${shape.numInstances ?? 1}`,
      `${p}x=${Number(shape.x ?? 0.5).toFixed(3)}`,
      `${p}y=${Number(shape.y ?? 0.5).toFixed(3)}`,
      `${p}rad=${Number(shape.rad ?? 0.1).toFixed(5)}`,
      `${p}ang=0.00000`,
      `${p}tex_ang=0.00000`,
      `${p}tex_zoom=1.00000`,
      `${p}r=${Number(shape.r ?? 1).toFixed(3)}`,
      `${p}g=${Number(shape.g ?? 1).toFixed(3)}`,
      `${p}b=${Number(shape.b ?? 1).toFixed(3)}`,
      `${p}a=${Number(shape.a ?? 0.5).toFixed(3)}`,
      `${p}r2=${Number(shape.r2 ?? 0).toFixed(3)}`,
      `${p}g2=${Number(shape.g2 ?? 0).toFixed(3)}`,
      `${p}b2=${Number(shape.b2 ?? 0).toFixed(3)}`,
      `${p}a2=${Number(shape.a2 ?? 0).toFixed(3)}`,
      `${p}border_r=${Number(shape.borderR ?? 1).toFixed(3)}`,
      `${p}border_g=${Number(shape.borderG ?? 1).toFixed(3)}`,
      `${p}border_b=${Number(shape.borderB ?? 1).toFixed(3)}`,
      `${p}border_a=${Number(shape.borderA ?? 0).toFixed(3)}`,
    );
  }

  for (const wave of spec.waves ?? []) {
    out.push(...numbered(`wave_${wave.index}_per_frame`, wave.perFrame));
    out.push(...numbered(`wave_${wave.index}_per_point`, wave.perPoint));
  }
  for (const shape of spec.shapes ?? []) {
    out.push(...numbered(`shape_${shape.index}_per_frame`, shape.perFrame));
  }

  out.push(...numbered('per_frame_', spec.perFrame));
  out.push(...numbered('per_pixel_', spec.perPixel));

  if (spec.warp) out.push(...numbered('warp_', ['shader_body', '{', ...spec.warp.map((l) => `   ${l}`), '}'], true));
  if (spec.comp) out.push(...numbered('comp_', ['shader_body', '{', ...spec.comp.map((l) => `   ${l}`), '}'], true));

  return `${out.join('\r\n')}\r\n`;
}

/* -------------------------------- main ---------------------------------- */

const VARIANTS_PER_FAMILY = 8;

async function main() {
  const random = makeRandom(0x5eed1234);
  const used = new Set();
  let written = 0;

  for (const archetype of ARCHETYPES) {
    const dir = path.join(OUT_ROOT, archetype.family);
    await fs.mkdir(dir, { recursive: true });

    for (let i = 0; i < VARIANTS_PER_FAMILY; i++) {
      const v = variantAxes(i, random);
      const spec = archetype.build(v);

      let name = archetype.names[i % archetype.names.length];
      if (used.has(name)) name = `${name} ${Math.floor(i / archetype.names.length) + 2}`;
      used.add(name);

      const file = path.join(dir, `${name}.milk`);
      await fs.writeFile(file, emitPreset(spec), 'utf8');
      written++;
    }
    console.log(`  ${archetype.family.padEnd(12)} ${VARIANTS_PER_FAMILY} presets`);
  }

  console.log(`\nWrote ${written} presets into resources/milk/`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
