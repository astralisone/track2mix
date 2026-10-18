import { describe, expect, it } from "vitest";
import { scheduleClip, type ClipChain } from "@/audio/graph";
import { fadeGainAt, type Clip } from "@/audio/model";

type Call = [string, ...number[]];

function fakeParam(calls: Call[], name: string) {
  return {
    value: 0,
    cancelScheduledValues: (t: number) => calls.push([`${name}.cancel`, t]),
    setValueAtTime: (v: number, t: number) => calls.push([`${name}.set`, v, t]),
    linearRampToValueAtTime: (v: number, t: number) => calls.push([`${name}.ramp`, v, t]),
    setTargetAtTime: (v: number, t: number, tc: number) => calls.push([`${name}.target`, v, t, tc]),
  };
}

function fakeChain() {
  const calls: Call[] = [];
  const starts: Array<[number, number, number]> = [];
  const chain = {
    source: {
      playbackRate: fakeParam(calls, "rate"),
      start: (when: number, offset: number, dur: number) => starts.push([when, offset, dur]),
    },
    fade: { gain: fakeParam(calls, "fade") },
    hp: { frequency: fakeParam(calls, "hp") },
    lp: { frequency: fakeParam(calls, "lp") },
    low: { gain: fakeParam(calls, "low") },
    mid: { gain: fakeParam(calls, "mid") },
    high: { gain: fakeParam(calls, "high") },
    gain: { gain: fakeParam(calls, "gain") },
    disconnect: () => {},
  };
  return { chain: chain as unknown as ClipChain, calls, starts };
}

/**
 * Evaluate the Web Audio automation timeline produced by the fake param the
 * way the spec does: events sorted by time; setValueAtTime holds; a
 * linearRamp interpolates from the previous event's (value, time).
 */
function evalEnvelope(calls: Call[], t: number): number {
  const ev = calls
    .filter((c) => c[0] === "fade.set" || c[0] === "fade.ramp")
    .map((c) => ({ kind: c[0], v: c[1], t: c[2] }))
    .sort((a, b) => a.t - b.t);
  let v = 1; // default gain
  let prev: { v: number; t: number } | null = null;
  for (const e of ev) {
    if (e.kind === "fade.set") {
      if (e.t <= t) {
        v = e.v;
        prev = { v: e.v, t: e.t };
      } else break;
    } else {
      if (e.t <= t) {
        v = e.v;
        prev = { v: e.v, t: e.t };
      } else {
        const p = prev ?? { v: 1, t: 0 };
        const f = (t - p.t) / (e.t - p.t);
        return p.v + (e.v - p.v) * f;
      }
    }
  }
  return v;
}

describe("scheduleClip with fades that exceed the clip duration (adversarial)", () => {
  // 10 s of source, fades normalised at rate 1 (5 + 5). After the master BPM
  // moves the lane to rate 1.4 nothing re-normalises, so the clip is 7.14 s
  // long with 10 s of fades.
  const clip: Clip = {
    id: "A",
    laneId: "a",
    start: 0,
    offset: 0,
    length: 10,
    fadeIn: 5,
    fadeOut: 5,
  };
  const rate = 1.4;
  const dur = clip.length / rate; // 7.142857

  it("schedules a monotone envelope that matches fadeGainAt (was: silence then a hard jump)", () => {
    const { chain, calls } = fakeChain();
    expect(scheduleClip(chain, clip, rate, 0, 0)).toBe(true);
    const fade = calls.filter((c) => c[0] === "fade.set" || c[0] === "fade.ramp");
    // Automation events are in non-decreasing time order.
    for (let i = 1; i < fade.length; i++) expect(fade[i][2]).toBeGreaterThanOrEqual(fade[i - 1][2]);
    // And the scheduled curve is the model's curve at every sample point.
    for (let t = 0; t <= dur; t += dur / 50) {
      expect(evalEnvelope(calls, t)).toBeCloseTo(fadeGainAt(clip, rate, t), 6);
    }
    // Peak is the crossing value, not 1 — no click.
    expect(Math.max(...fade.map((c) => c[1]))).toBeCloseTo(dur / 10, 6);
  });

  it("matches fadeGainAt when playback starts inside the overlapping region", () => {
    const { chain, calls } = fakeChain();
    const from = 4; // past the crossing at dur/2 ≈ 3.57
    expect(scheduleClip(chain, clip, rate, from, 100)).toBe(true);
    const setCall = calls.find((c) => c[0] === "fade.set")!;
    expect(setCall[1]).toBeCloseTo(fadeGainAt(clip, rate, from), 6);
    expect(setCall[2]).toBe(100);
    for (let t = from; t <= dur; t += 0.25) {
      // ctx time = 100 + (t - from)
      expect(evalEnvelope(calls, 100 + (t - from))).toBeCloseTo(fadeGainAt(clip, rate, t), 6);
    }
  });
});
