/**
 * Beat-grid estimation from decoded audio.
 *
 * Rekordbox gives us a tempo but not where the beats fall, and a clip whose
 * first sample lands on a bar line only beat-matches if that sample is
 * itself on a beat. So, given a track's tagged BPM, find the exact tempo
 * (tags are often rounded to a whole number) and the phase of the beat
 * grid, and, more tentatively, which of the four beat phases is the
 * downbeat.
 *
 * Method: an onset-strength envelope at 100 frames/s (half-wave rectified
 * difference of log energy), then a comb over every candidate phase at
 * every candidate tempo within ±1% of the tag, summing the onset strength
 * at beat-spaced positions. The (tempo, phase) with the strongest mean
 * per beat is the grid. For the downbeat, the same comb at bar spacing
 * over the four candidate beats, scored mostly on a low-band (kick)
 * envelope. Beats come out reliably on anything with a drum track; the
 * downbeat choice is a best guess and reported as such by `confidence`.
 */

export type BeatGrid = {
  /** Refined tempo, within ±1% of the tag. */
  bpm: number;
  /** Source seconds from the start of the audio to the first beat. */
  beatOffset: number;
  /** Source seconds to the first estimated downbeat (within the first bar). */
  barOffset: number;
  /** Peak comb score over the mean; ~1 is noise, 2+ is a clear grid. 0 when unusable. */
  confidence: number;
};

export const NO_GRID: BeatGrid = { bpm: 0, beatOffset: 0, barOffset: 0, confidence: 0 };

const FPS = 100;
/** Tempo search: ±TEMPO_RANGE around the tag in TEMPO_STEP increments (fractions). */
const TEMPO_RANGE = 0.01;
const TEMPO_STEP = 0.0005;
const LOW_CUTOFF_HZ = 150;
const DEFAULT_ANALYSIS_SECONDS = 120;

type Envelopes = { onset: Float32Array; low: Float32Array; fps: number };

/**
 * Onset-strength envelopes, full-band and low-band, at `fps` frames per
 * second over at most `seconds` of audio.
 */
export function onsetEnvelopes(
  samples: Float32Array,
  sampleRate: number,
  seconds = DEFAULT_ANALYSIS_SECONDS,
  fps = FPS,
): Envelopes {
  const hop = Math.max(1, Math.round(sampleRate / fps));
  const frames = Math.min(Math.floor(samples.length / hop), Math.floor(seconds * fps));
  const full = new Float32Array(Math.max(0, frames));
  const lowE = new Float32Array(Math.max(0, frames));
  const a = 1 - Math.exp((-2 * Math.PI * LOW_CUTOFF_HZ) / sampleRate);
  let y = 0;
  for (let f = 0; f < frames; f++) {
    const s = f * hop;
    let e = 0;
    let el = 0;
    for (let i = s; i < s + hop; i++) {
      const x = samples[i];
      e += x * x;
      y += a * (x - y);
      el += y * y;
    }
    full[f] = Math.log1p(1000 * Math.sqrt(e / hop));
    lowE[f] = Math.log1p(1000 * Math.sqrt(el / hop));
  }
  const onset = new Float32Array(full.length);
  const low = new Float32Array(full.length);
  for (let f = 1; f < full.length; f++) {
    onset[f] = Math.max(0, full[f] - full[f - 1]);
    low[f] = Math.max(0, lowE[f] - lowE[f - 1]);
  }
  return { onset, low, fps: sampleRate / hop };
}

/** Strongest onset within ±1 frame of a fractional position. */
function at(env: Float32Array, pos: number): number {
  const i = Math.round(pos);
  let v = 0;
  for (let j = i - 1; j <= i + 1; j++) {
    if (j >= 0 && j < env.length && env[j] > v) v = env[j];
  }
  return v;
}

/** Mean onset strength per beat for a (phase, period) comb, and the beat count. */
function comb(env: Float32Array, phase: number, period: number): number {
  let sum = 0;
  let n = 0;
  for (let pos = phase; pos < env.length; pos += period) {
    sum += at(env, pos);
    n++;
  }
  return n === 0 ? 0 : sum / n;
}

/**
 * Estimate the beat grid of mono `samples` near a tagged `bpm`. Returns
 * `NO_GRID` when the tempo is unusable or there is less than two beats of
 * audio.
 */
export function estimateBeatGrid(
  samples: Float32Array,
  sampleRate: number,
  bpm: number,
  seconds = DEFAULT_ANALYSIS_SECONDS,
): BeatGrid {
  if (!Number.isFinite(bpm) || bpm <= 0 || sampleRate <= 0) return NO_GRID;
  const { onset, low, fps } = onsetEnvelopes(samples, sampleRate, seconds);
  if (onset.length < ((60 / bpm) * fps) * 2) return NO_GRID;

  let bestBpm = bpm;
  let bestPhase = 0;
  let bestPeriod = (60 / bpm) * fps;
  let bestScore = -1;
  let total = 0;
  let count = 0;
  const steps = Math.round(TEMPO_RANGE / TEMPO_STEP);
  for (let k = -steps; k <= steps; k++) {
    const cand = bpm * (1 + k * TEMPO_STEP);
    const period = (60 / cand) * fps;
    const phases = Math.ceil(period);
    for (let p = 0; p < phases; p++) {
      const s = comb(onset, p, period);
      total += s;
      count++;
      if (s > bestScore) {
        bestScore = s;
        bestBpm = cand;
        bestPhase = p;
        bestPeriod = period;
      }
    }
  }
  const mean = count === 0 ? 0 : total / count;
  if (bestScore <= 0 || mean <= 0) return NO_GRID;

  // Downbeat: which of the four beat phases carries the kicks and accents.
  let bar = 0;
  let barScore = -1;
  for (let m = 0; m < 4; m++) {
    const phase = bestPhase + m * bestPeriod;
    const s = comb(low, phase, bestPeriod * 4) + 0.5 * comb(onset, phase, bestPeriod * 4);
    if (s > barScore) {
      barScore = s;
      bar = m;
    }
  }

  return {
    bpm: Math.round(bestBpm * 100) / 100,
    beatOffset: bestPhase / fps,
    barOffset: (bestPhase + bar * bestPeriod) / fps,
    confidence: bestScore / mean,
  };
}

/** Mono-sum an AudioBuffer's first `seconds` and estimate its grid. */
export function beatGridFromBuffer(
  buf: AudioBuffer,
  bpm: number | null | undefined,
  seconds = DEFAULT_ANALYSIS_SECONDS,
): BeatGrid {
  if (bpm == null) return NO_GRID;
  const len = Math.min(buf.length, Math.ceil(seconds * buf.sampleRate));
  const mono = new Float32Array(len);
  const chans = buf.numberOfChannels;
  for (let c = 0; c < chans; c++) {
    const data = buf.getChannelData(c);
    for (let i = 0; i < len; i++) mono[i] += data[i] / chans;
  }
  return estimateBeatGrid(mono, buf.sampleRate, bpm, seconds);
}
