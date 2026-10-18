import { describe, expect, it } from "vitest";
import { applyLane, scheduleClip, type ClipChain } from "@/audio/graph";
import { DEFAULT_LANE, EQ_KILL, HP_MIN, LP_MAX, type Clip, type Lane } from "@/audio/model";
import type { UiTrack } from "@/lib/tauri";

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

const clip = (patch: Partial<Clip> = {}): Clip => ({
  id: "c",
  laneId: "a",
  start: 10,
  offset: 2,
  length: 8,
  fadeIn: 0,
  fadeOut: 0,
  ...patch,
});

const fadeCalls = (calls: Call[]) => calls.filter((c) => c[0].startsWith("fade."));

describe("scheduleClip", () => {
  it("skips clips that end before the start position", () => {
    const { chain, starts } = fakeChain();
    expect(scheduleClip(chain, clip(), 1, 18, 100)).toBe(false);
    expect(scheduleClip(chain, clip(), 1, 25, 100)).toBe(false);
    expect(starts).toHaveLength(0);
  });

  it("schedules a future clip at the right context time", () => {
    const { chain, starts, calls } = fakeChain();
    expect(scheduleClip(chain, clip(), 1, 5, 100)).toBe(true);
    expect(starts).toEqual([[105, 2, 8]]);
    expect(chain.source.playbackRate.value).toBe(1);
    expect(fadeCalls(calls)).toEqual([
      ["fade.cancel", 0],
      ["fade.set", 1, 105],
    ]);
  });

  it("starts mid-clip with source offset scaled by rate", () => {
    const { chain, starts } = fakeChain();
    // length 9 at rate 1.5 → 6s on the timeline (10..16); start at 12 → 2s skipped = 3 source seconds
    expect(scheduleClip(chain, clip({ length: 9 }), 1.5, 12, 100)).toBe(true);
    expect(starts).toEqual([[100, 5, 6]]);
    expect(chain.source.playbackRate.value).toBe(1.5);
  });

  it("schedules a fade-in from silence", () => {
    const { chain, calls } = fakeChain();
    scheduleClip(chain, clip({ offset: 0, fadeIn: 2 }), 1, 0, 100);
    expect(fadeCalls(calls)).toEqual([
      ["fade.cancel", 0],
      ["fade.set", 0, 110],
      ["fade.ramp", 1, 112],
    ]);
  });

  it("starts mid fade-in at the interpolated gain", () => {
    const { chain, calls } = fakeChain();
    scheduleClip(chain, clip({ offset: 0, fadeIn: 2 }), 1, 11, 100);
    expect(fadeCalls(calls)).toEqual([
      ["fade.cancel", 0],
      ["fade.set", 0.5, 100],
      ["fade.ramp", 1, 101],
    ]);
  });

  it("schedules a fade-out to silence at the clip end", () => {
    const { chain, calls } = fakeChain();
    scheduleClip(chain, clip({ offset: 0, fadeOut: 2 }), 1, 0, 100);
    expect(fadeCalls(calls)).toEqual([
      ["fade.cancel", 0],
      ["fade.set", 1, 110],
      ["fade.set", 1, 116],
      ["fade.ramp", 0, 118],
    ]);
  });

  it("starts inside the fade-out and ramps the remainder", () => {
    const { chain, calls } = fakeChain();
    scheduleClip(chain, clip({ offset: 0, fadeOut: 2 }), 1, 17, 100);
    expect(fadeCalls(calls)).toEqual([
      ["fade.cancel", 0],
      ["fade.set", 0.5, 100],
      ["fade.ramp", 0, 101],
    ]);
  });

  it("maps fades under a playback rate in timeline seconds", () => {
    const { chain, calls, starts } = fakeChain();
    // 8 source seconds at rate 2 → 4s timeline (10..14)
    scheduleClip(chain, clip({ offset: 0, fadeIn: 1, fadeOut: 1 }), 2, 0, 100);
    expect(starts).toEqual([[110, 0, 8]]);
    expect(fadeCalls(calls)).toEqual([
      ["fade.cancel", 0],
      ["fade.set", 0, 110],
      ["fade.ramp", 1, 111],
      ["fade.set", 1, 113],
      ["fade.ramp", 0, 114],
    ]);
  });
});

describe("applyLane", () => {
  const track: UiTrack = {
    track_id: "t",
    name: "t",
    artist: "",
    genre: "",
    sub_genre: null,
    bpm: 174,
    tonality: "8A",
    camelot: "8A",
    energy_raw: null,
    energy: null,
    file_path: "/x.mp3",
  };
  const lane = (patch: Partial<Lane> = {}): Lane => ({ id: "a", track, ...DEFAULT_LANE, ...patch });

  const targets = (calls: Call[]) =>
    Object.fromEntries(calls.filter((c) => c[0].endsWith(".target")).map((c) => [c[0].replace(".target", ""), c[1]]));

  it("pushes lane values and the rate onto the chain", () => {
    const { chain, calls } = fakeChain();
    applyLane(chain, lane({ gain: 0.8, hp: 300, lp: 8000, eqLow: -6, eqMid: 3, eqHigh: 0 }), 1.25, true, 50, 0.02);
    expect(targets(calls)).toEqual({ gain: 0.8, hp: 300, lp: 8000, low: -6, mid: 3, high: 0 });
    expect(calls).toContainEqual(["rate.set", 1.25, 50]);
    expect(calls.filter((c) => c[0].endsWith(".cancel")).every((c) => c[1] === 50)).toBe(true);
    expect(calls.filter((c) => c[0].endsWith(".target")).every((c) => c[2] === 50 && c[3] === 0.02)).toBe(true);
  });

  it("silences inaudible lanes but keeps their processing", () => {
    const { chain, calls } = fakeChain();
    applyLane(chain, lane({ gain: 1.2 }), 1, false, 0);
    expect(targets(calls).gain).toBe(0);
    expect(targets(calls).hp).toBe(HP_MIN);
  });

  it("clamps filter and EQ ranges", () => {
    const { chain, calls } = fakeChain();
    applyLane(chain, lane({ hp: 5, lp: 30_000, eqLow: -40, eqMid: -100, eqHigh: -26.5 }), 1, true, 0);
    expect(targets(calls)).toMatchObject({ hp: HP_MIN, lp: LP_MAX, low: EQ_KILL, mid: EQ_KILL, high: EQ_KILL });
  });
});
