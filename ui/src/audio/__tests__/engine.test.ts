import { describe, expect, it } from "vitest";
import { structurallyEqual } from "@/audio/engine";
import { DEFAULT_LANE, type Clip, type Composition, type Lane } from "@/audio/model";
import type { UiTrack } from "@/lib/tauri";

const t = (id: string): UiTrack => ({
  track_id: id,
  name: id,
  artist: "",
  genre: "",
  sub_genre: null,
  bpm: 174,
  tonality: "8A",
  camelot: "8A",
  energy_raw: null,
  energy: null,
  file_path: "/x.mp3",
});
const lane = (id: string, patch: Partial<Lane> = {}): Lane => ({ id, track: t(`t-${id}`), ...DEFAULT_LANE, ...patch });
const clip = (id: string, patch: Partial<Clip> = {}): Clip => ({ id, laneId: "a", start: 0, offset: 0, length: 10, fadeIn: 0, fadeOut: 0, ...patch });
const comp = (patch: Partial<Composition> = {}): Composition => ({
  masterBpm: 174,
  snap: true,
  lanes: [lane("a")],
  clips: [clip("c1")],
  ...patch,
});

describe("structurallyEqual", () => {
  it("treats knob-only changes as equal", () => {
    const a = comp();
    const b = comp({ lanes: [lane("a", { gain: 0.3, eqLow: -26, hp: 400, mute: true, solo: true })], snap: false });
    expect(structurallyEqual(a, b)).toBe(true);
  });

  it("detects structural changes", () => {
    const a = comp();
    expect(structurallyEqual(a, comp({ masterBpm: 170 }))).toBe(false);
    expect(structurallyEqual(a, comp({ clips: [clip("c1", { start: 1 })] }))).toBe(false);
    expect(structurallyEqual(a, comp({ clips: [clip("c1", { fadeOut: 2 })] }))).toBe(false);
    expect(structurallyEqual(a, comp({ clips: [clip("c2")] }))).toBe(false);
    expect(structurallyEqual(a, comp({ clips: [] }))).toBe(false);
    expect(structurallyEqual(a, comp({ lanes: [lane("a", { sync: false })] }))).toBe(false);
    expect(structurallyEqual(a, comp({ lanes: [lane("b")] }))).toBe(false);
    expect(structurallyEqual(a, comp({ lanes: [lane("a"), lane("b")] }))).toBe(false);
  });
});
