/** Number of waveform / spectrum samples handed to visualizers. */
export const WAVE_SAMPLES = 512;
export const SPEC_SAMPLES = 512;

/**
 * One frame of analysed audio.
 *
 * The band values (bass/mid/treb and their `*Att` partners) follow MilkDrop's
 * convention: they are *relative* levels centred on 1.0, produced by dividing
 * instantaneous band energy by a slow-moving long-term average. That is why a
 * quiet passage still drives a preset - what matters is the deviation from the
 * track's own recent loudness, not absolute dBFS. Presets written for MilkDrop
 * assume exactly this scaling.
 */
export interface AudioFrame {
  /** Seconds since the engine started. Monotonic, unaffected by source changes. */
  time: number;
  /** Seconds elapsed since the previous frame, clamped to a sane range. */
  dt: number;
  frame: number;

  /** MilkDrop-compatible relative band levels, ~1.0 = average, 0 = silence. */
  bass: number;
  mid: number;
  treb: number;
  /** Attenuated (fast-attack / slow-release) versions of the above. */
  bassAtt: number;
  midAtt: number;
  trebAtt: number;

  /** Mean of the three bands, and its attenuated partner. */
  vol: number;
  volAtt: number;

  /** Absolute loudness measures in 0..1, useful for shaders that want them. */
  rms: number;
  peak: number;

  /** True on the frame a beat is detected. */
  beat: boolean;
  /** How strongly the onset exceeded the adaptive threshold, 0..~4. */
  beatIntensity: number;
  /** Decays from 1 to 0 after each beat; nice for pulse effects. */
  beatPulse: number;
  /** Estimated tempo, 0 when not confident. */
  bpm: number;
  bpmConfidence: number;

  /** Time-domain samples in -1..1. */
  waveL: Float32Array;
  waveR: Float32Array;
  /** Per-channel magnitude spectrum in 0..1, low bin first. */
  specL: Float32Array;
  specR: Float32Array;
  /** Mono magnitude spectrum in 0..1 - what the audio texture is built from. */
  spectrum: Float32Array;

  /** True when a live signal is present (not silence, not stopped). */
  active: boolean;
}

export type SourceKind = 'loopback' | 'microphone' | 'device' | 'file' | 'none';

export interface SourceStatus {
  kind: SourceKind;
  label: string;
  active: boolean;
  error?: string;
  sampleRate?: number;
  channels?: number;
}

export function createEmptyFrame(): AudioFrame {
  return {
    time: 0,
    dt: 1 / 60,
    frame: 0,
    bass: 0,
    mid: 0,
    treb: 0,
    bassAtt: 0,
    midAtt: 0,
    trebAtt: 0,
    vol: 0,
    volAtt: 0,
    rms: 0,
    peak: 0,
    beat: false,
    beatIntensity: 0,
    beatPulse: 0,
    bpm: 0,
    bpmConfidence: 0,
    waveL: new Float32Array(WAVE_SAMPLES),
    waveR: new Float32Array(WAVE_SAMPLES),
    specL: new Float32Array(SPEC_SAMPLES),
    specR: new Float32Array(SPEC_SAMPLES),
    spectrum: new Float32Array(SPEC_SAMPLES),
    active: false,
  };
}
