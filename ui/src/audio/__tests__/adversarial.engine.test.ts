import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_LANE, type Clip, type Composition, type Lane } from "@/audio/model";

/**
 * A minimal AudioContext stand-in: enough for CompositionEngine's constructor
 * and for startFrom() when no buffers are loaded (clips whose lane is
 * missing are skipped, so no source nodes are ever created).
 */
class FakeParam {
  value = 0;
  cancelScheduledValues() {}
  setValueAtTime() {}
  linearRampToValueAtTime() {}
  setTargetAtTime() {}
}
class FakeNode {
  gain = new FakeParam();
  frequency = new FakeParam();
  Q = new FakeParam();
  fftSize = 0;
  connect() {}
  disconnect() {}
}
class FakeAudioContext {
  currentTime = 10;
  state: "running" | "suspended" | "closed" = "running";
  sampleRate = 48000;
  destination = new FakeNode();
  createGain() {
    return new FakeNode();
  }
  createAnalyser() {
    return new FakeNode();
  }
  createBiquadFilter() {
    return new FakeNode();
  }
  createBufferSource() {
    return Object.assign(new FakeNode(), { playbackRate: new FakeParam(), start() {}, stop() {} });
  }
  resume() {
    this.state = "running";
    return Promise.resolve();
  }
  close() {
    this.state = "closed";
    return Promise.resolve();
  }
}

// A lane whose audio is never decoded: the engine counts its clips as
// structure and length but creates no source nodes for them.
const ghostLane: Lane = {
  id: "ghost",
  track: {
    track_id: "ghost-track",
    name: "ghost",
    artist: "",
    genre: "",
    sub_genre: null,
    bpm: null,
    tonality: "",
    camelot: null,
    energy_raw: null,
    energy: null,
    file_path: "/ghost.mp3",
  },
  ...DEFAULT_LANE,
};

const clip = (id: string, patch: Partial<Clip> = {}): Clip => ({
  id,
  laneId: "ghost",
  start: 0,
  offset: 0,
  length: 10,
  fadeIn: 0,
  fadeOut: 0,
  ...patch,
});
const comp = (patch: Partial<Composition> = {}): Composition => ({
  masterBpm: 174,
  snap: true,
  lanes: [ghostLane],
  clips: [clip("c1")],
  ...patch,
});

let rafCallbacks: FrameRequestCallback[] = [];

beforeEach(() => {
  rafCallbacks = [];
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    rafCallbacks.push(cb);
    return rafCallbacks.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
});
afterEach(() => vi.unstubAllGlobals());

async function makeEngine(c: Composition) {
  const { CompositionEngine } = await import("@/audio/engine");
  const engine = new CompositionEngine(c);
  // No Tauri IPC in node: pretend the decode happened but leave the cache
  // empty, so startFrom() finds no buffer and schedules nothing.
  vi.spyOn(engine.loader, "load").mockResolvedValue({} as AudioBuffer);
  const ctx = engine.ctx as unknown as FakeAudioContext;
  return { engine, ctx };
}

describe("CompositionEngine position clock (adversarial)", () => {
  // Was BLOCKER 1 in the verifier report: the clock origin used to be the
  // lookahead-shifted schedule time, so position() started 50 ms negative.
  it("never reports a negative position right after play(0)", async () => {
    const { engine, ctx } = await makeEngine(comp());
    await engine.play(0);
    expect(engine.position()).toBe(0);
    ctx.currentTime += 0.016;
    engine.pause();
    expect(engine.position()).toBeCloseTo(0.016, 6);
  });

  it("keeps the playhead moving forward when structural changes arrive faster than every 50 ms (clip drag while playing)", async () => {
    const { engine, ctx } = await makeEngine(comp());
    await engine.play(0);
    ctx.currentTime += 1;
    const before = engine.position();
    expect(before).toBeCloseTo(1, 6);

    // Simulate a mouse drag at 60 Hz: each move changes clip.start → structural → restart.
    let start = 0;
    for (let i = 0; i < 30; i++) {
      ctx.currentTime += 0.016;
      start += 0.01;
      engine.setComposition(comp({ clips: [clip("c1", { start })] }));
    }
    const after = engine.position();
    // 30 × 16 ms of wall-clock passed; the position advanced by the same.
    expect(after).toBeCloseTo(before + 0.48, 6);
  });

  it("holds structural reschedules until endGesture() and applies them once", async () => {
    const { engine, ctx } = await makeEngine(comp());
    await engine.play(0);
    ctx.currentTime += 1;
    engine.beginGesture();
    for (let i = 0; i < 10; i++) {
      ctx.currentTime += 0.016;
      engine.setComposition(comp({ clips: [clip("c1", { start: i * 0.1 })] }));
    }
    expect(engine.state().playing).toBe(true);
    expect(engine.position()).toBeCloseTo(1.16, 6);
    engine.endGesture();
    expect(engine.state().playing).toBe(true);
    expect(engine.position()).toBeCloseTo(1.16, 6);
    expect(engine.composition.clips[0].start).toBeCloseTo(0.9, 6);
  });

  it("does not double-start when play() is called twice while preloading", async () => {
    const { engine } = await makeEngine(comp());
    const a = engine.play(0);
    const b = engine.play(0);
    expect(b).toBe(a);
    await a;
    expect(engine.state().playing).toBe(true);
  });

  it("play() on an empty composition resolves without entering the playing state", async () => {
    const { engine } = await makeEngine(comp({ clips: [] }));
    await engine.play(3);
    expect(engine.state()).toMatchObject({ playing: false, position: 3 });
  });

  it("seek() while playing lands on the requested position", async () => {
    const { engine, ctx } = await makeEngine(comp());
    await engine.play(0);
    ctx.currentTime += 1;
    engine.seek(5);
    expect(engine.position()).toBeCloseTo(5, 6);
  });
});

describe("CompositionEngine tick() (adversarial)", () => {
  it("stops when everything is deleted while playing (compositionLength === 0)", async () => {
    const { engine, ctx } = await makeEngine(comp());
    await engine.play(0);
    engine.setComposition(comp({ clips: [] }));
    for (let i = 0; i < 100; i++) {
      ctx.currentTime += 1;
      const cbs = rafCallbacks.splice(0);
      for (const cb of cbs) cb(0);
    }
    expect(engine.state().playing).toBe(false);
  });
});
