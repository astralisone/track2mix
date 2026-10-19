import { describe, expect, test } from "vitest";
import { estimateBeatGrid, NO_GRID, onsetEnvelopes } from "../src/audio/beats";

const SR = 44_100;

/**
 * Synthetic drum loop: a short noise burst on every beat, and on downbeats
 * a louder burst plus a 60 Hz thump. `firstBeat` is where the grid starts;
 * `downbeatIndex` says which beat of the grid is the first downbeat.
 */
function clickTrack(
  bpm: number,
  seconds: number,
  firstBeat: number,
  downbeatIndex = 0,
  seed = 1,
): Float32Array {
  const out = new Float32Array(Math.floor(seconds * SR));
  const period = 60 / bpm;
  let rnd = seed;
  const noise = () => {
    rnd = (rnd * 1103515245 + 12345) & 0x7fffffff;
    return rnd / 0x7fffffff - 0.5;
  };
  // Quiet hiss so the envelope isn't exactly zero between hits.
  for (let i = 0; i < out.length; i++) out[i] = noise() * 0.002;
  for (let k = 0; ; k++) {
    const t = firstBeat + k * period;
    const s = Math.floor(t * SR);
    if (s >= out.length) break;
    const down = (k - downbeatIndex) % 4 === 0 && k >= downbeatIndex;
    const len = Math.floor(0.02 * SR);
    for (let i = 0; i < len && s + i < out.length; i++) {
      const env = 1 - i / len;
      out[s + i] += noise() * (down ? 0.9 : 0.4) * env;
      if (down) out[s + i] += 0.6 * Math.sin((2 * Math.PI * 60 * i) / SR) * env;
    }
  }
  return out;
}

describe("estimateBeatGrid", () => {
  test("finds the beat phase of a click track", () => {
    const g = estimateBeatGrid(clickTrack(120, 20, 0.25), SR, 120);
    expect(g.confidence).toBeGreaterThan(2);
    expect(Math.abs(g.beatOffset - 0.25)).toBeLessThan(0.012);
    expect(Math.abs(g.barOffset - 0.25)).toBeLessThan(0.012);
  });

  test("picks the accented, bass-heavy beat as the downbeat", () => {
    // Grid starts at 0.1 s; the first downbeat is beat #2 → 0.1 + 2 × 0.5.
    const g = estimateBeatGrid(clickTrack(120, 20, 0.1, 2), SR, 120);
    expect(Math.abs(g.beatOffset - 0.1)).toBeLessThan(0.012);
    expect(Math.abs(g.barOffset - 1.1)).toBeLessThan(0.012);
  });

  test("works at drum & bass tempo with a late start", () => {
    const g = estimateBeatGrid(clickTrack(174, 30, 0.3, 1), SR, 174);
    const beat = 60 / 174;
    expect(Math.abs(g.beatOffset - 0.3)).toBeLessThan(0.012);
    expect(Math.abs(g.barOffset - (0.3 + beat))).toBeLessThan(0.012);
  });

  test("refines a rounded tempo tag", () => {
    const g = estimateBeatGrid(clickTrack(173.4, 60, 0.2), SR, 174);
    expect(Math.abs(g.bpm - 173.4)).toBeLessThan(0.1);
    expect(Math.abs(g.beatOffset - 0.2)).toBeLessThan(0.015);
    expect(g.confidence).toBeGreaterThan(2);
  });

  test("keeps an exact tag", () => {
    const g = estimateBeatGrid(clickTrack(120, 40, 0.25), SR, 120);
    expect(Math.abs(g.bpm - 120)).toBeLessThan(0.07);
  });

  test("beat offset stays inside the first period", () => {
    const g = estimateBeatGrid(clickTrack(100, 15, 0.45), SR, 100);
    expect(g.beatOffset).toBeGreaterThanOrEqual(0);
    expect(g.beatOffset).toBeLessThan(0.6);
    expect(g.barOffset).toBeLessThan(2.4);
  });

  test("silence and bad tempos give no grid", () => {
    expect(estimateBeatGrid(new Float32Array(SR * 5), SR, 120)).toEqual(NO_GRID);
    expect(estimateBeatGrid(clickTrack(120, 5, 0), SR, 0)).toEqual(NO_GRID);
    expect(estimateBeatGrid(clickTrack(120, 5, 0), SR, NaN)).toEqual(NO_GRID);
    // Less than two beats of audio.
    expect(estimateBeatGrid(new Float32Array(SR * 0.5), SR, 60)).toEqual(NO_GRID);
  });

  test("silence has a low-confidence grid even with a faint hiss", () => {
    const hiss = new Float32Array(SR * 10);
    let r = 7;
    for (let i = 0; i < hiss.length; i++) {
      r = (r * 1103515245 + 12345) & 0x7fffffff;
      hiss[i] = (r / 0x7fffffff - 0.5) * 0.01;
    }
    const g = estimateBeatGrid(hiss, SR, 128);
    expect(g.confidence).toBeLessThan(1.5);
  });
});

describe("onsetEnvelopes", () => {
  test("limits analysis to the requested window", () => {
    const env = onsetEnvelopes(clickTrack(120, 30, 0), SR, 10);
    expect(env.onset.length).toBe(1000);
    expect(env.low.length).toBe(1000);
    expect(Math.round(env.fps)).toBe(100);
  });
});
