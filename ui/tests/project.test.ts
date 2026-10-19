import { describe, expect, test } from "vitest";
import type { UiTrack } from "@/lib/tauri";
import { DEFAULT_LANE, emptyComposition, type Composition, type Lane } from "@/audio/model";
import {
  compositionFingerprint,
  fileStem,
  parseProject,
  projectNameFromPath,
  PROJECT_VERSION,
  resolveProject,
  resolveTrack,
  serializeProject,
  toProjectFile,
  withProjectExt,
} from "@/audio/project";

function track(id: string, over: Partial<UiTrack> = {}): UiTrack {
  return {
    track_id: id,
    name: `Track ${id}`,
    artist: "Artist",
    genre: "DnB",
    sub_genre: null,
    bpm: 174,
    tonality: "Am",
    camelot: "8A",
    energy_raw: 0.5,
    energy: 5,
    file_path: `/music/${id}.mp3`,
    ...over,
  };
}

function lane(id: string, t: UiTrack, over: Partial<Lane> = {}): Lane {
  return { id, track: t, ...DEFAULT_LANE, ...over };
}

function sample(): Composition {
  const a = track("1");
  const b = track("2", { bpm: 87 });
  return {
    masterBpm: 174,
    snap: false,
    lanes: [lane("L1", a, { gain: 0.8, eqLow: -26 }), lane("L2", b, { sync: false, mute: true })],
    clips: [
      { id: "c1", laneId: "L1", start: 0, offset: 0, length: 120, fadeIn: 0, fadeOut: 8, fadeOutAuto: true },
      { id: "c2", laneId: "L2", start: 112, offset: 4, length: 240, fadeIn: 8, fadeOut: 0, fadeInAuto: true },
    ],
  };
}

const meta = { name: "Friday set", library: "/lib/t2m.db", now: new Date("2026-10-18T12:00:00Z") };

describe("project file round trip", () => {
  test("serialize → parse → resolve reproduces the composition", () => {
    const comp = sample();
    const text = serializeProject(comp, meta);
    const file = parseProject(text);
    expect(file.name).toBe("Friday set");
    expect(file.version).toBe(PROJECT_VERSION);
    expect(file.savedAt).toBe("2026-10-18T12:00:00.000Z");
    expect(file.library).toBe("/lib/t2m.db");
    const { comp: back, missing } = resolveProject(file, [track("1"), track("2", { bpm: 87 })]);
    expect(missing).toEqual([]);
    expect(compositionFingerprint(back)).toBe(compositionFingerprint(comp));
    expect(back.lanes.every((l) => l.seeded)).toBe(true);
    expect(back.lanes[0].gain).toBe(0.8);
    expect(back.lanes[1].mute).toBe(true);
    expect(back.clips[1].fadeInAuto).toBe(true);
  });

  test("the file is stable JSON with the track snapshot, not engine state", () => {
    const file = toProjectFile(sample(), meta);
    expect(file.composition.lanes[0].track.file_path).toBe("/music/1.mp3");
    expect("seeded" in file.composition.lanes[0]).toBe(false);
    const text = serializeProject(sample(), meta);
    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text).format).toBe("track2mix-composition");
  });

  test("blank names fall back to Untitled", () => {
    expect(toProjectFile(emptyComposition(), { ...meta, name: "  " }).name).toBe("Untitled mix");
  });
});

describe("parseProject validation", () => {
  const good = () => JSON.parse(serializeProject(sample(), meta));

  test("rejects non-JSON, foreign formats and newer versions", () => {
    expect(() => parseProject("{nope")).toThrow(/not valid JSON/);
    expect(() => parseProject(JSON.stringify({ format: "other" }))).toThrow(/not a Track2Mix/);
    const newer = { ...good(), version: PROJECT_VERSION + 1 };
    expect(() => parseProject(JSON.stringify(newer))).toThrow(/newer Track2Mix/);
  });

  test("rejects structurally broken arrangements", () => {
    const noLanes = { ...good(), composition: { ...good().composition, lanes: "x" } };
    expect(() => parseProject(JSON.stringify(noLanes))).toThrow(/lanes must be an array/);
    const badClip = good();
    badClip.composition.clips[0].length = 0;
    expect(() => parseProject(JSON.stringify(badClip))).toThrow(/clips\[0\]\.length/);
    const noId = good();
    delete noId.composition.lanes[0].track.track_id;
    expect(() => parseProject(JSON.stringify(noId))).toThrow(/track_id/);
    const dup = good();
    dup.composition.lanes[1].id = dup.composition.lanes[0].id;
    expect(() => parseProject(JSON.stringify(dup))).toThrow(/duplicate lane id/);
    const bpm = good();
    bpm.composition.masterBpm = 999;
    expect(() => parseProject(JSON.stringify(bpm))).toThrow(/masterBpm/);
  });

  test("fills missing knob values with defaults and clamps out-of-range ones", () => {
    const f = good();
    delete f.composition.lanes[0].eqMid;
    f.composition.lanes[0].gain = 9;
    f.composition.lanes[0].hp = -5;
    delete f.composition.snap;
    const parsed = parseProject(JSON.stringify(f));
    expect(parsed.composition.lanes[0].eqMid).toBe(0);
    expect(parsed.composition.lanes[0].gain).toBe(1.5);
    expect(parsed.composition.lanes[0].hp).toBe(20);
    expect(parsed.composition.snap).toBe(true);
  });
});

describe("resolving lanes against a library", () => {
  test("same id and path → that track", () => {
    expect(resolveTrack(track("1"), [track("1")])?.track_id).toBe("1");
  });

  test("ids renumbered by a re-export → match on file path", () => {
    const lib = [
      track("9", { name: "Renamed", file_path: "/music/1.mp3" }),
      track("1", { name: "Other", file_path: "/x.mp3" }),
    ];
    // Saved id "1" now names a different file; the saved path lives under id 9.
    const saved = track("1");
    expect(resolveTrack(saved, lib)?.track_id).toBe("9");
  });

  test("moved files → match on name and artist", () => {
    const lib = [track("5", { name: "Track 1", file_path: "/moved/1.mp3" })];
    const saved = track("1");
    expect(resolveTrack(saved, lib)?.track_id).toBe("5");
  });

  test("unresolvable lanes are reported and their clips dropped", () => {
    const file = parseProject(serializeProject(sample(), meta));
    const { comp, missing } = resolveProject(file, [track("1")]);
    expect(comp.lanes.map((l) => l.id)).toEqual(["L1"]);
    expect(comp.clips.map((c) => c.id)).toEqual(["c1"]);
    expect(missing).toHaveLength(1);
    expect(missing[0].lane.track.name).toBe("Track 2");
    expect(missing[0].reason).toMatch(/not in this library/);
  });

  test("a track without audio can't be a lane", () => {
    const file = parseProject(serializeProject(sample(), meta));
    const { comp, missing } = resolveProject(file, [track("1", { file_path: null }), track("2")]);
    expect(comp.lanes.map((l) => l.id)).toEqual(["L2"]);
    expect(missing[0].reason).toMatch(/no audio file/);
  });
});

describe("change detection", () => {
  test("knob and clip edits change the fingerprint, library metadata does not", () => {
    const base = sample();
    const fp = compositionFingerprint(base);
    expect(compositionFingerprint(sample())).toBe(fp);
    const knob = sample();
    knob.lanes[0].gain = 0.5;
    expect(compositionFingerprint(knob)).not.toBe(fp);
    const moved = sample();
    moved.clips[0].start = 1;
    expect(compositionFingerprint(moved)).not.toBe(fp);
    const relabelled = sample();
    relabelled.lanes[0].track = { ...relabelled.lanes[0].track, energy: 9, genre: "House" };
    expect(compositionFingerprint(relabelled)).toBe(fp);
    const empty = emptyComposition();
    expect(compositionFingerprint(empty)).toBe(compositionFingerprint(emptyComposition()));
  });
});

describe("names", () => {
  test("project name from path strips directory and extension", () => {
    expect(projectNameFromPath("/a/b/My Mix.t2m")).toBe("My Mix");
    expect(projectNameFromPath("C:\\sets\\late.T2M")).toBe("late");
    expect(projectNameFromPath("/a/.t2m")).toBe("Untitled mix");
  });
  test("withProjectExt appends only when needed", () => {
    expect(withProjectExt("/a/x")).toBe("/a/x.t2m");
    expect(withProjectExt("/a/x.t2m")).toBe("/a/x.t2m");
    expect(withProjectExt("/a/x.T2M")).toBe("/a/x.T2M");
  });
  test("fileStem is filesystem safe", () => {
    expect(fileStem("Friday set / v2!")).toBe("Friday-set-v2");
    expect(fileStem("   ")).toBe("track2mix");
    expect(fileStem("Café mix")).toBe("Cafe-mix");
  });
});
