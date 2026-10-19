import { describe, expect, test } from "vitest";
import {
  autoArrange,
  chooseMasterBpm,
  describeArrangement,
  foldBpm,
  type LaneAudio,
} from "../src/audio/arrange";
import {
  barSeconds,
  clipEnd,
  DEFAULT_LANE,
  emptyComposition,
  laneRate,
  type Composition,
  type Lane,
} from "../src/audio/model";
import type { UiTrack } from "../src/lib/tauri";

function track(id: string, bpm: number | null, camelot: string | null, energy: number | null): UiTrack {
  return {
    track_id: id,
    name: `Track ${id}`,
    artist: "A",
    genre: "Drum & Bass",
    sub_genre: null,
    bpm,
    tonality: "",
    camelot,
    energy_raw: energy,
    energy,
    file_path: `/music/${id}.mp3`,
  };
}

function lane(id: string, t: UiTrack): Lane {
  return { id, track: t, ...DEFAULT_LANE };
}

function audio(
  entries: Array<[string, number, number?, number?]>,
): Map<string, LaneAudio> {
  return new Map(
    entries.map(([id, duration, barOffset, bpm]) => [
      id,
      {
        duration,
        grid:
          barOffset == null
            ? null
            : { bpm: bpm ?? 0, beatOffset: barOffset, barOffset, confidence: 3 },
      },
    ]),
  );
}

function comp(lanes: Lane[], masterBpm = 174): Composition {
  return { ...emptyComposition(), masterBpm, lanes };
}

const nearBar = (t: number, bar: number) => Math.abs(t / bar - Math.round(t / bar)) < 1e-6;

describe("tempo helpers", () => {
  test("foldBpm brings half/double tempos into the reference octave", () => {
    expect(foldBpm(87, 174)).toBe(174);
    expect(foldBpm(348, 174)).toBe(174);
    expect(foldBpm(172, 174)).toBe(172);
    expect(foldBpm(140, 174)).toBe(140);
  });

  test("chooseMasterBpm is the folded median, rounded", () => {
    const lanes = [
      lane("a", track("1", 174, "8A", 5)),
      lane("b", track("2", 87, "8A", 5)), // half-time tag → 174
      lane("c", track("3", 176.004, "8A", 5)),
    ];
    expect(chooseMasterBpm(lanes, 120)).toBe(174);
    expect(chooseMasterBpm([], 120)).toBe(120);
    expect(chooseMasterBpm([lane("a", track("1", null, null, null))], 120)).toBe(120);
    const even = [lane("a", track("1", 170, null, null)), lane("b", track("2", 174, null, null))];
    expect(chooseMasterBpm(even, 120)).toBe(172);
  });
});

describe("autoArrange", () => {
  const lanes = [
    lane("hi", track("1", 174, "3A", 8)),
    lane("lo", track("2", 172, "8A", 3)),
    lane("mid", track("3", 176, "9A", 5)),
  ];
  const au = audio([
    ["hi", 300, 0.2],
    ["lo", 280, 0.5],
    ["mid", 320, 0.0],
  ]);

  test("harmonic order starts low and follows the key wheel", () => {
    const r = autoArrange(comp(lanes), au, { overlapBars: 16, order: "harmonic" });
    expect(r.comp.lanes.map((l) => l.id)).toEqual(["lo", "mid", "hi"]);
    expect(r.comp.clips.map((c) => c.laneId)).toEqual(["lo", "mid", "hi"]);
    expect(r.skippedLaneIds).toEqual([]);
    expect(r.transitions.map((t) => t.relation)).toEqual(["adjacent", "clash"]);
  });

  test("energy order sorts by energy only", () => {
    const r = autoArrange(comp(lanes), au, { overlapBars: 16, order: "energy" });
    expect(r.comp.lanes.map((l) => l.id)).toEqual(["lo", "mid", "hi"]);
  });

  test("keep order leaves the lanes alone", () => {
    const r = autoArrange(comp(lanes), au, { overlapBars: 16, order: "keep" });
    expect(r.comp.lanes.map((l) => l.id)).toEqual(["hi", "lo", "mid"]);
  });

  test("a chosen start lane opens the mix", () => {
    const r = autoArrange(comp(lanes), au, { overlapBars: 16, order: "harmonic", startLaneId: "hi" });
    expect(r.comp.lanes[0].id).toBe("hi");
  });

  test("clips start on bar lines, trimmed to the downbeat, with bar-aligned overlaps and fades", () => {
    const r = autoArrange(comp(lanes), au, { overlapBars: 16, order: "harmonic" });
    const { masterBpm, clips } = r.comp;
    expect(masterBpm).toBe(174);
    const bar = barSeconds(masterBpm);
    const byLane = new Map(clips.map((c) => [c.laneId, c]));
    const rateOf = (id: string) => laneRate(r.comp.lanes.find((l) => l.id === id)!, masterBpm);

    expect(byLane.get("lo")!.start).toBe(0);
    expect(byLane.get("lo")!.offset).toBe(0.5);
    expect(byLane.get("lo")!.length).toBe(280 - 0.5);
    expect(byLane.get("mid")!.offset).toBe(0);
    expect(byLane.get("hi")!.offset).toBe(0.2);

    for (const c of clips) expect(nearBar(c.start, bar)).toBe(true);

    // Consecutive clips overlap by ~16 bars and sit on an 8-bar phrase of the outgoing clip.
    const order = ["lo", "mid", "hi"];
    for (let i = 1; i < order.length; i++) {
      const prev = byLane.get(order[i - 1])!;
      const cur = byLane.get(order[i])!;
      const prevEnd = clipEnd(prev, rateOf(prev.laneId));
      const overlap = prevEnd - cur.start;
      expect(overlap).toBeGreaterThan(12 * bar);
      expect(overlap).toBeLessThan(20 * bar);
      expect(nearBar(cur.start - prev.start, 8 * bar)).toBe(true);
      // Auto-crossfade wrote the fades across the overlap.
      expect(prev.fadeOut).toBeCloseTo(overlap, 6);
      expect(cur.fadeIn).toBeCloseTo(overlap, 6);
      expect(prev.fadeOutAuto).toBe(true);
      expect(cur.fadeInAuto).toBe(true);
      expect(r.transitions[i - 1].at).toBe(cur.start);
      expect(r.transitions[i - 1].overlapBars).toBe(Math.round(overlap / bar));
    }
    expect(byLane.get("lo")!.fadeIn).toBe(0);
    expect(byLane.get("hi")!.fadeOut).toBe(0);
  });

  test("overlap is capped at a third of the shorter track", () => {
    const short = [lane("a", track("1", 174, "8A", 3)), lane("b", track("2", 174, "8A", 5))];
    const bar = barSeconds(174);
    const r = autoArrange(comp(short), audio([["a", 300, 0], ["b", 12 * bar, 0]]), {
      overlapBars: 32,
      order: "keep",
    });
    const [a, b] = r.comp.clips;
    const overlap = clipEnd(a, 1) - b.start;
    expect(overlap).toBeLessThanOrEqual(4 * bar + 1e-6);
    expect(overlap).toBeGreaterThanOrEqual(bar - 1e-6);
    expect(r.transitions[0].overlapBars).toBeLessThanOrEqual(4);
  });

  test("lanes without audio are skipped but kept", () => {
    const r = autoArrange(comp(lanes), audio([["hi", 300, 0], ["lo", 280, 0]]), {
      overlapBars: 8,
      order: "harmonic",
    });
    expect(r.skippedLaneIds).toEqual(["mid"]);
    expect(r.comp.lanes.map((l) => l.id)).toEqual(["lo", "hi", "mid"]);
    expect(r.comp.clips.map((c) => c.laneId)).toEqual(["lo", "hi"]);
    expect(describeArrangement(r)).toContain("1 lane skipped");
  });

  test("replaces existing clips and keeps the other composition fields", () => {
    const c: Composition = {
      ...comp(lanes),
      snap: false,
      clips: [{ id: "old", laneId: "hi", start: 10, offset: 3, length: 50, fadeIn: 1, fadeOut: 1 }],
    };
    const r = autoArrange(c, au, { overlapBars: 8, order: "keep" });
    expect(r.comp.snap).toBe(false);
    expect(r.comp.clips.some((cl) => cl.id === "old")).toBe(false);
    expect(r.comp.clips).toHaveLength(3);
  });

  test("a single lane becomes one clip at zero", () => {
    const r = autoArrange(comp([lanes[0]]), au, { overlapBars: 16, order: "harmonic" });
    expect(r.comp.clips).toHaveLength(1);
    expect(r.comp.clips[0].start).toBe(0);
    expect(r.transitions).toEqual([]);
    expect(describeArrangement(r)).toContain("Arranged 1 track");
  });

  test("nothing loaded gives an empty arrangement", () => {
    const r = autoArrange(comp(lanes), new Map(), { overlapBars: 16, order: "harmonic" });
    expect(r.comp.clips).toEqual([]);
    expect(r.skippedLaneIds).toHaveLength(3);
    expect(describeArrangement(r)).toContain("Nothing to arrange");
  });

  test("a confident refined tempo replaces the lane's tagged BPM", () => {
    const l = [lane("a", track("1", 174, "8A", 3)), lane("b", track("2", 174, "8A", 4))];
    const r = autoArrange(comp(l), audio([["a", 300, 0, 173.4], ["b", 300, 0, 174]]), {
      overlapBars: 16,
      order: "keep",
    });
    expect(r.comp.lanes[0].track.bpm).toBe(173.4);
    expect(r.comp.lanes[1].track.bpm).toBe(174);
    // Median of the refined tempos, so neither track stretches much.
    expect(r.comp.masterBpm).toBe(173.7);
    expect(laneRate(r.comp.lanes[0], r.comp.masterBpm)).toBeCloseTo(173.7 / 173.4, 6);
  });

  test("a low-confidence or wildly different refined tempo is ignored", () => {
    const l = [lane("a", track("1", 174, "8A", 3))];
    const weak = new Map<string, LaneAudio>([
      ["a", { duration: 300, grid: { bpm: 173.4, beatOffset: 0, barOffset: 0, confidence: 1.1 } }],
    ]);
    expect(autoArrange(comp(l), weak, { overlapBars: 16, order: "keep" }).comp.lanes[0].track.bpm).toBe(174);
    const far = new Map<string, LaneAudio>([
      ["a", { duration: 300, grid: { bpm: 160, beatOffset: 0, barOffset: 0, confidence: 4 } }],
    ]);
    expect(autoArrange(comp(l), far, { overlapBars: 16, order: "keep" }).comp.lanes[0].track.bpm).toBe(174);
  });

  test("half-time tagged tracks sync at 1× and still land on bars", () => {
    const l = [lane("a", track("1", 174, "8A", 3)), lane("b", track("2", 87, "8A", 4))];
    const r = autoArrange(comp(l), audio([["a", 300, 0.1], ["b", 300, 0.3]]), {
      overlapBars: 16,
      order: "keep",
    });
    expect(r.comp.masterBpm).toBe(174);
    const b = r.comp.lanes.find((x) => x.id === "b")!;
    expect(laneRate(b, r.comp.masterBpm)).toBe(1);
    const bar = barSeconds(174);
    for (const c of r.comp.clips) expect(nearBar(c.start, bar)).toBe(true);
  });
});
