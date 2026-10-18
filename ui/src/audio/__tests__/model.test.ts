import { describe, expect, it } from "vitest";
import type { UiTrack } from "@/lib/tauri";
import {
  autoCrossfade,
  barSeconds,
  beatSeconds,
  clipDuration,
  clipEnd,
  compositionLength,
  DEFAULT_LANE,
  fadeGainAt,
  formatBar,
  formatTime,
  gridForZoom,
  laneAudible,
  laneRate,
  normalizeFades,
  snapTime,
  type Clip,
  type Composition,
  type Lane,
} from "@/audio/model";

function track(bpm: number | null, id = "t1"): UiTrack {
  return {
    track_id: id,
    name: id,
    artist: "a",
    genre: "g",
    sub_genre: null,
    bpm,
    tonality: "8A",
    camelot: "8A",
    energy_raw: 0.5,
    energy: 5,
    file_path: `/music/${id}.mp3`,
  };
}

function lane(id: string, bpm: number | null, patch: Partial<Lane> = {}): Lane {
  return { id, track: track(bpm, `track-${id}`), ...DEFAULT_LANE, ...patch };
}

function clip(laneId: string, start: number, length: number, patch: Partial<Clip> = {}): Clip {
  return { id: `c-${laneId}-${start}`, laneId, start, offset: 0, length, fadeIn: 0, fadeOut: 0, ...patch };
}

describe("laneRate", () => {
  it("is 1 when not synced or no bpm", () => {
    expect(laneRate(lane("a", 150, { sync: false }), 174)).toBe(1);
    expect(laneRate(lane("a", null), 174)).toBe(1);
    expect(laneRate(lane("a", 0), 174)).toBe(1);
    expect(laneRate(lane("a", 150), 0)).toBe(1);
  });

  it("matches master bpm, folding by octaves", () => {
    expect(laneRate(lane("a", 174), 174)).toBe(1);
    expect(laneRate(lane("a", 87), 174)).toBe(1);
    expect(laneRate(lane("a", 348), 174)).toBe(1);
    expect(laneRate(lane("a", 172), 174)).toBeCloseTo(174 / 172, 6);
    expect(laneRate(lane("a", 140), 174)).toBeCloseTo(174 / 140, 6);
    // 120 vs 174 → 1.45, inside the fold window
    expect(laneRate(lane("a", 120), 174)).toBeCloseTo(1.45, 6);
  });
});

describe("clip geometry", () => {
  it("scales duration by rate", () => {
    const c = clip("a", 10, 8);
    expect(clipDuration(c, 1)).toBe(8);
    expect(clipDuration(c, 2)).toBe(4);
    expect(clipEnd(c, 1)).toBe(18);
    expect(clipEnd(c, 0.5)).toBe(26);
  });
});

describe("grid", () => {
  it("computes bar and beat lengths", () => {
    expect(beatSeconds(120)).toBe(0.5);
    expect(barSeconds(120)).toBe(2);
    expect(barSeconds(120, 3)).toBe(1.5);
  });

  it("snaps to the nearest grid line and clamps at 0", () => {
    expect(snapTime(2.3, 120, 0.5)).toBe(2.5);
    expect(snapTime(2.2, 120, 0.5)).toBe(2);
    expect(snapTime(-1, 120, 0.5)).toBe(0);
    expect(snapTime(2.3, 120, 0)).toBe(2.3);
    expect(snapTime(2.3, 0, 0.5)).toBe(2.3);
  });

  it("picks the smallest grid that stays at least minPx apart", () => {
    const beat = 60 / 174;
    expect(gridForZoom(174, 100)).toBeCloseTo(beat, 9); // beat = 34px
    expect(gridForZoom(174, 12)).toBeCloseTo(beat * 8, 9); // 4 beats = 16px, 8 = 33px
    expect(gridForZoom(174, 1)).toBeCloseTo(beat * 64, 9); // caps at the largest candidate
    expect(gridForZoom(120, 10, 10)).toBeCloseTo(2, 9); // beat = 5px, bar = 20px
  });
});

describe("compositionLength", () => {
  it("is the latest clip end accounting for lane rate", () => {
    const comp: Composition = {
      masterBpm: 174,
      snap: true,
      lanes: [lane("a", 174), lane("b", 87)],
      clips: [clip("a", 0, 10), clip("b", 5, 10)],
    };
    expect(compositionLength(comp)).toBe(15);
    comp.lanes[1] = lane("b", 348); // rate folds to 1 as well
    expect(compositionLength(comp)).toBe(15);
    comp.lanes[1] = lane("b", 140); // rate ≈ 1.243 → clip b is shorter
    expect(compositionLength(comp)).toBeCloseTo(5 + 10 / (174 / 140), 6);
  });

  it("ignores clips whose lane is missing and is 0 when empty", () => {
    expect(compositionLength({ masterBpm: 174, snap: true, lanes: [], clips: [clip("x", 0, 10)] })).toBe(0);
  });
});

describe("laneAudible", () => {
  it("respects mute and solo", () => {
    const a = lane("a", 174);
    const b = lane("b", 174);
    expect(laneAudible(a, [a, b])).toBe(true);
    expect(laneAudible({ ...a, mute: true }, [a, b])).toBe(false);
    const bSolo = { ...b, solo: true };
    expect(laneAudible(a, [a, bSolo])).toBe(false);
    expect(laneAudible(bSolo, [a, bSolo])).toBe(true);
    expect(laneAudible({ ...bSolo, mute: true }, [a, bSolo])).toBe(false);
  });
});

describe("fades", () => {
  const c = clip("a", 10, 8, { fadeIn: 2, fadeOut: 2 });

  it("fadeGainAt follows the envelope", () => {
    expect(fadeGainAt(c, 1, 9)).toBe(0);
    expect(fadeGainAt(c, 1, 19)).toBe(0);
    expect(fadeGainAt(c, 1, 10)).toBe(0);
    expect(fadeGainAt(c, 1, 11)).toBeCloseTo(0.5);
    expect(fadeGainAt(c, 1, 12)).toBe(1);
    expect(fadeGainAt(c, 1, 14)).toBe(1);
    expect(fadeGainAt(c, 1, 17)).toBeCloseTo(0.5);
    expect(fadeGainAt(c, 1, 18)).toBe(0);
  });

  it("fadeGainAt uses timeline duration under a rate", () => {
    // rate 2 → 4s on the timeline, fades are still timeline seconds
    const fast = clip("a", 10, 8, { fadeIn: 1, fadeOut: 1 });
    expect(fadeGainAt(fast, 2, 10.5)).toBeCloseTo(0.5);
    expect(fadeGainAt(fast, 2, 12)).toBe(1);
    expect(fadeGainAt(fast, 2, 13.5)).toBeCloseTo(0.5);
    expect(fadeGainAt(fast, 2, 14.5)).toBe(0);
  });

  it("normalizeFades clamps to the clip duration", () => {
    // Each fade is clamped to the duration independently; overlapping fades
    // are a valid shape (the envelope is the lower of the two lines).
    expect(normalizeFades(clip("a", 0, 8, { fadeIn: 10, fadeOut: 5 }), 1)).toMatchObject({ fadeIn: 8, fadeOut: 5 });
    expect(normalizeFades(clip("a", 0, 8, { fadeIn: 3, fadeOut: 10 }), 1)).toMatchObject({ fadeIn: 3, fadeOut: 8 });
    expect(normalizeFades(clip("a", 0, 8, { fadeIn: -1, fadeOut: -1 }), 1)).toMatchObject({ fadeIn: 0, fadeOut: 0 });
    expect(normalizeFades(clip("a", 0, 8, { fadeIn: 6, fadeOut: 1 }), 2)).toMatchObject({ fadeIn: 4, fadeOut: 1 });
  });
});

describe("autoCrossfade", () => {
  const base = (clips: Clip[], lanes: Lane[] = [lane("a", 174), lane("b", 174)]): Composition => ({
    masterBpm: 174,
    snap: true,
    lanes,
    clips,
  });

  it("fades across the overlap of clips on different lanes", () => {
    const out = autoCrossfade(base([clip("a", 0, 10), clip("b", 6, 10)]));
    expect(out.clips[0]).toMatchObject({ fadeIn: 0, fadeOut: 4 });
    expect(out.clips[1]).toMatchObject({ fadeIn: 4, fadeOut: 0 });
  });

  it("leaves fades the user set alone, longer or shorter", () => {
    // A non-zero fade without an auto flag is a manual fade.
    const out = autoCrossfade(base([clip("a", 0, 10, { fadeOut: 6 }), clip("b", 6, 10, { fadeIn: 1 })]));
    expect(out.clips[0].fadeOut).toBe(6);
    expect(out.clips[1].fadeIn).toBe(1);
    // Explicitly non-auto zero fades stay zero as well.
    const zero = autoCrossfade(base([clip("a", 0, 10, { fadeOutAuto: false }), clip("b", 6, 10)]));
    expect(zero.clips[0].fadeOut).toBe(0);
    expect(zero.clips[1]).toMatchObject({ fadeIn: 4, fadeInAuto: true });
  });

  it("only touches the changed clips and their overlap partners when scoped", () => {
    const first = autoCrossfade(base([clip("a", 0, 10), clip("b", 6, 10)]));
    // Move b away but scope the call to an unrelated new clip: a's auto fade keeps its last value…
    const moved = { ...first, clips: [...first.clips.map((c) => (c.id === first.clips[1].id ? { ...c, start: 50 } : c)), clip("b", 100, 5)] };
    const scoped = autoCrossfade(moved, [moved.clips[2].id]);
    expect(scoped.clips[0].fadeOut).toBe(4);
    // …and an unscoped call recomputes it.
    expect(autoCrossfade(moved).clips[0].fadeOut).toBe(0);
  });

  it("ignores same-lane and non-overlapping clips", () => {
    const same = autoCrossfade(base([clip("a", 0, 10), clip("a", 6, 10)]));
    expect(same.clips.every((c) => c.fadeIn === 0 && c.fadeOut === 0)).toBe(true);
    const apart = autoCrossfade(base([clip("a", 0, 10), clip("b", 10, 10)]));
    expect(apart.clips.every((c) => c.fadeIn === 0 && c.fadeOut === 0)).toBe(true);
  });

  it("measures the overlap in timeline seconds under a rate", () => {
    // lane b at 87bpm synced to 174 folds to rate 1; lane at 140 runs faster
    const out = autoCrossfade(base([clip("a", 0, 10), clip("b", 8, 10)], [lane("a", 174), lane("b", 140)]));
    const rateB = 174 / 140;
    const overlap = Math.min(10, 8 + 10 / rateB) - 8;
    expect(out.clips[0].fadeOut).toBeCloseTo(overlap, 6);
    expect(out.clips[1].fadeIn).toBeCloseTo(overlap, 6);
  });

  it("does not mutate the input", () => {
    const input = base([clip("a", 0, 10), clip("b", 6, 10)]);
    autoCrossfade(input);
    expect(input.clips[0].fadeOut).toBe(0);
  });
});

describe("formatting", () => {
  it("formatTime", () => {
    expect(formatTime(0)).toBe("0:00.0");
    expect(formatTime(65.25)).toBe("1:05.2");
    expect(formatTime(-3)).toBe("0:00.0");
    expect(formatTime(NaN)).toBe("0:00.0");
  });

  it("formatBar", () => {
    expect(formatBar(0, 120)).toBe("1.1");
    expect(formatBar(4.5, 120)).toBe("3.2");
    expect(formatBar(1.9, 120)).toBe("1.4");
  });
});
