/**
 * Onset / beat / tempo detection.
 *
 * Three stages:
 *   1. Spectral flux - sum of positive frame-to-frame magnitude increases,
 *      weighted toward the low end where percussive energy lives.
 *   2. Adaptive thresholding - a beat is an onset that stands out from the
 *      local mean by a multiple of the local spread, with a refractory period
 *      so one kick drum doesn't fire three times.
 *   3. Tempo - autocorrelation of the onset envelope over lags in the
 *      60-200 BPM range, recomputed a few times a second rather than per frame.
 *
 * Everything works on the per-frame onset envelope (~60 Hz), so the whole thing
 * costs microseconds.
 */

/** ~6 seconds of onset history at 60fps - enough for a stable tempo estimate. */
const HISTORY = 384;
const MIN_BPM = 60;
const MAX_BPM = 200;
/** Shortest gap between reported beats. 200ms caps us at 300 BPM of onsets. */
const REFRACTORY_S = 0.16;

export interface BeatResult {
  beat: boolean;
  intensity: number;
  pulse: number;
  bpm: number;
  confidence: number;
}

export class BeatDetector {
  private prevSpec: Float32Array | null = null;
  private readonly flux = new Float32Array(HISTORY);
  private writeIndex = 0;
  private filled = 0;

  private lastBeatTime = -1;
  private pulse = 0;
  private bpm = 0;
  private confidence = 0;
  private framesSinceTempo = 0;

  /** Frame interval estimate, updated continuously so tempo maths stay honest. */
  private avgDt = 1 / 60;

  reset(): void {
    this.prevSpec = null;
    this.flux.fill(0);
    this.writeIndex = 0;
    this.filled = 0;
    this.lastBeatTime = -1;
    this.pulse = 0;
    this.bpm = 0;
    this.confidence = 0;
  }

  /**
   * @param spec  Magnitude spectrum, 0..1, low bin first.
   * @param time  Seconds since engine start.
   * @param dt    Seconds since previous call.
   * @param sensitivity  User multiplier; >1 makes beats easier to trigger.
   */
  update(spec: Float32Array, time: number, dt: number, sensitivity: number): BeatResult {
    this.avgDt = this.avgDt * 0.95 + Math.min(Math.max(dt, 1 / 240), 1 / 15) * 0.05;

    let flux = 0;
    if (this.prevSpec && this.prevSpec.length === spec.length) {
      const n = spec.length;
      // Only the lower ~5/8 of the spectrum: kicks and snares dominate there,
      // and hats/cymbals otherwise smear the envelope into mush.
      const limit = Math.floor(n * 0.625);
      for (let i = 0; i < limit; i++) {
        const diff = spec[i] - this.prevSpec[i];
        if (diff > 0) {
          // Weight low bins higher, tapering across the band.
          const w = 1 - (i / limit) * 0.65;
          flux += diff * w;
        }
      }
      flux /= limit;
    }
    if (!this.prevSpec || this.prevSpec.length !== spec.length) {
      this.prevSpec = new Float32Array(spec.length);
    }
    this.prevSpec.set(spec);

    this.flux[this.writeIndex] = flux;
    this.writeIndex = (this.writeIndex + 1) % HISTORY;
    if (this.filled < HISTORY) this.filled++;

    // Local statistics over the last ~0.7s decide what "stands out" means now.
    const window = Math.min(this.filled, 43);
    let mean = 0;
    for (let i = 0; i < window; i++) {
      mean += this.flux[(this.writeIndex - 1 - i + HISTORY * 2) % HISTORY];
    }
    mean /= Math.max(window, 1);

    let variance = 0;
    for (let i = 0; i < window; i++) {
      const v = this.flux[(this.writeIndex - 1 - i + HISTORY * 2) % HISTORY] - mean;
      variance += v * v;
    }
    const std = Math.sqrt(variance / Math.max(window, 1));

    const k = 1.55 / Math.max(sensitivity, 0.05);
    const threshold = mean + k * std + 1e-6;

    let beat = false;
    let intensity = 0;
    if (
      flux > threshold &&
      this.filled > 12 &&
      (this.lastBeatTime < 0 || time - this.lastBeatTime > REFRACTORY_S)
    ) {
      beat = true;
      this.lastBeatTime = time;
      intensity = Math.min((flux - mean) / Math.max(std, 1e-6) / 2, 4);
      this.pulse = 1;
    }

    // Exponential decay tuned so the pulse is ~gone after 250ms.
    this.pulse *= Math.exp(-dt / 0.12);
    if (this.pulse < 1e-4) this.pulse = 0;

    if (++this.framesSinceTempo >= 20) {
      this.framesSinceTempo = 0;
      this.estimateTempo();
    }

    return {
      beat,
      intensity,
      pulse: this.pulse,
      bpm: this.bpm,
      confidence: this.confidence,
    };
  }

  /**
   * Autocorrelate the onset envelope and pick the strongest musically plausible
   * lag. Octave errors (half/double tempo) are resolved by preferring the
   * candidate nearest 120 BPM, which is where most material actually sits.
   */
  private estimateTempo(): void {
    if (this.filled < HISTORY / 2) {
      this.confidence *= 0.9;
      return;
    }

    const n = this.filled;
    // Linearise the ring buffer, oldest first.
    const env = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      env[i] = this.flux[(this.writeIndex - n + i + HISTORY * 2) % HISTORY];
    }

    let mean = 0;
    for (let i = 0; i < n; i++) mean += env[i];
    mean /= n;
    let energy = 0;
    for (let i = 0; i < n; i++) {
      env[i] -= mean;
      energy += env[i] * env[i];
    }
    if (energy < 1e-9) {
      this.confidence *= 0.9;
      return;
    }

    const minLag = Math.max(2, Math.round(60 / (MAX_BPM * this.avgDt)));
    const maxLag = Math.min(n - 2, Math.round(60 / (MIN_BPM * this.avgDt)));
    if (maxLag <= minLag) return;

    let bestLag = 0;
    let bestScore = 0;
    const candidates: Array<{ lag: number; score: number }> = [];

    for (let lag = minLag; lag <= maxLag; lag++) {
      let sum = 0;
      for (let i = lag; i < n; i++) sum += env[i] * env[i - lag];
      const score = sum / (energy * (1 - lag / n / 2));
      candidates.push({ lag, score });
      if (score > bestScore) {
        bestScore = score;
        bestLag = lag;
      }
    }
    if (bestLag === 0 || bestScore <= 0) {
      this.confidence *= 0.9;
      return;
    }

    // Consider the winner and its octave relatives, then prefer the one closest
    // to 120 BPM among those that scored respectably.
    const rawBpm = 60 / (bestLag * this.avgDt);
    let chosen = rawBpm;
    let chosenScore = bestScore;
    for (const mult of [0.5, 2]) {
      const alt = rawBpm * mult;
      if (alt < MIN_BPM || alt > MAX_BPM) continue;
      const altLag = Math.round(60 / (alt * this.avgDt));
      const found = candidates.find((c) => c.lag === altLag);
      if (!found) continue;
      if (
        found.score > bestScore * 0.72 &&
        Math.abs(alt - 120) < Math.abs(chosen - 120)
      ) {
        chosen = alt;
        chosenScore = found.score;
      }
    }

    const target = Math.round(chosen * 10) / 10;
    // Ease toward the new estimate so the readout doesn't jitter.
    this.bpm = this.bpm > 0 ? this.bpm * 0.7 + target * 0.3 : target;
    this.confidence = Math.min(Math.max(chosenScore, 0), 1);
  }
}
