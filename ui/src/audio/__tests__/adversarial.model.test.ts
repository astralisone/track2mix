import { describe, expect, it } from "vitest";
import {
  autoCrossfade,
  clipDuration,
  DEFAULT_LANE,
  fadeBreakpoints,
  fadeGainAt,
  laneRate,
  normalizeFades,
  type Clip,
  type Composition,
  type Lane,
} from "@/audio/model";
import type { UiTrack } from "@/lib/tauri";

const t = (id: string, bpm = 174): UiTrack => ({
  track_id: id,
  name: id,
  artist: "",
  genre: "",
  sub_genre: null,
  bpm,
  tonality: "8A",
  camelot: "8A",
  energy_raw: null,
  energy: null,
  file_path: "/x.mp3",
});
const lane = (id: string, patch: Partial<Lane> = {}, bpm = 174): Lane => ({
  id,
  track: t(`t-${id}`, bpm),
  ...DEFAULT_LANE,
  ...patch,
});
const clip = (id: string, laneId: string, patch: Partial<Clip> = {}): Clip => ({
  id,
  laneId,
  start: 0,
  offset: 0,
  length: 10,
  fadeIn: 0,
  fadeOut: 0,
  ...patch,
});
const comp = (patch: Partial<Composition>): Composition => ({
  masterBpm: 174,
  snap: true,
  lanes: [],
  clips: [],
  ...patch,
});

describe("autoCrossfade (adversarial)", () => {
  // Was BLOCKER 2 in the verifier report.
  it("keeps a fade the user deliberately shortened while clips overlap", () => {
    // A: 0..100 on lane a, B: 80..180 on lane b → 20 s overlap.
    const c = comp({
      lanes: [lane("a"), lane("b")],
      clips: [clip("A", "a", { length: 100 }), clip("B", "b", { start: 80, length: 100 })],
    });
    const first = autoCrossfade(c);
    expect(first.clips[0].fadeOut).toBe(20);

    expect(first.clips[0].fadeOutAuto).toBe(true);

    // User drags A's fade-out handle in to 4 s: the UI hands over ownership
    // by clearing the auto flag alongside the new value.
    const shortened = {
      ...first,
      clips: first.clips.map((cl) => (cl.id === "A" ? { ...cl, fadeOut: 4, fadeOutAuto: false } : cl)),
    };
    const after = autoCrossfade(shortened, ["A"]);
    expect(after.clips[0].fadeOut).toBe(4);
    // B's facing fade is still auto and still spans the overlap.
    expect(after.clips[1].fadeIn).toBe(20);
  });

  it("gives a nested clip its own short fades and leaves the host clip alone", () => {
    // A: 0..100 on lane a, B: 10..30 on lane b (B entirely inside A).
    const c = comp({
      lanes: [lane("a"), lane("b")],
      clips: [clip("A", "a", { length: 100 }), clip("B", "b", { start: 10, length: 20 })],
    });
    const out = autoCrossfade(c);
    const A = out.clips[0];
    const B = out.clips[1];
    // A's fade-out would sit at its end (80..100) where nothing else plays.
    expect(A.fadeOut).toBe(0);
    expect(fadeGainAt(A, 1, 90)).toBe(1);
    // B gets one bar in and out (174 bpm → 1.379 s), capped at half its length.
    const bar = 240 / 174;
    expect(B.fadeIn).toBeCloseTo(bar, 6);
    expect(B.fadeOut).toBeCloseTo(bar, 6);
    expect(B.fadeIn).toBeLessThan(clipDuration(B, 1) / 2);
  });

  it("clears auto fades once the overlap is gone", () => {
    const c = comp({
      lanes: [lane("a"), lane("b")],
      clips: [clip("A", "a", { length: 100 }), clip("B", "b", { start: 80, length: 100 })],
    });
    const overlapped = autoCrossfade(c);
    // Move B away so there is no overlap any more.
    const moved = {
      ...overlapped,
      clips: overlapped.clips.map((cl) => (cl.id === "B" ? { ...cl, start: 200 } : cl)),
    };
    const out = autoCrossfade(moved);
    expect(out.clips[0].fadeOut).toBe(0);
    expect(out.clips[1].fadeIn).toBe(0);
  });
});

describe("fades after a rate change (adversarial)", () => {
  it("fadeBreakpoints stays monotone when a tempo change makes fadeIn+fadeOut exceed the clip duration", () => {
    // Clip normalised at rate 1: 5 s in + 5 s out on a 10 s clip.
    const l = lane("a");
    const c0 = normalizeFades(clip("A", "a", { length: 10, fadeIn: 5, fadeOut: 5 }), 1);
    expect(c0.fadeIn + c0.fadeOut).toBeLessThanOrEqual(clipDuration(c0, 1));

    // Transport → onBpm commits { ...comp, masterBpm } with no normalisation.
    const rate = laneRate(l, 174 * 1.4); // 1.4
    expect(rate).toBeCloseTo(1.4);
    const dur = clipDuration(c0, rate); // ≈ 7.14 s
    expect(c0.fadeIn + c0.fadeOut).toBeGreaterThan(dur); // 10 > 7.14: fades overlap
    const bps = fadeBreakpoints(c0, rate);
    // 0 → crossing (dur/2 at rel = dur/2 since the fades are equal) → 0
    expect(bps.map((b) => b.g)).toEqual([0, dur / (5 + 5), 0]);
    expect(bps[1].t).toBeCloseTo(dur / 2, 6);
    for (let i = 1; i < bps.length; i++) expect(bps[i].t).toBeGreaterThan(bps[i - 1].t);
  });
});
