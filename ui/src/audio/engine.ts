import { AudioLoader } from "./loader";
import { applyLane, buildClipChain, scheduleClip, type ClipChain } from "./graph";
import {
  clipEnd,
  compositionLength,
  laneAudible,
  laneRate,
  type Composition,
} from "./model";
import { PcmCapture } from "./recorder";
import { encodeWav } from "./wav";

export type EngineState = {
  playing: boolean;
  position: number;
  recording: boolean;
  recordSeconds: number;
};

type Listener = (s: EngineState) => void;

/**
 * Realtime preview of a composition plus two ways of capturing it:
 * `startRecording`/`stopRecording` taps the live master bus (so fader and
 * EQ moves you make while it plays are kept), `bounce` renders the timeline
 * offline through an identical graph.
 */
export class CompositionEngine {
  readonly ctx: AudioContext;
  readonly loader: AudioLoader;
  readonly master: GainNode;
  readonly analyser: AnalyserNode;

  private comp: Composition;
  private chains = new Map<string, ClipChain>(); // clipId → chain
  private playing = false;
  /** Timeline position when playback last started, and ctx time then. */
  private startPos = 0;
  private startCtx = 0;
  private pausedPos = 0;
  private listeners = new Set<Listener>();
  private raf = 0;
  private capture: PcmCapture | null = null;
  private recordStartCtx = 0;

  constructor(comp: Composition) {
    this.ctx = new AudioContext({ latencyHint: "interactive" });
    this.loader = new AudioLoader(this.ctx);
    this.master = this.ctx.createGain();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.master.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
    this.comp = comp;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.state());
    return () => this.listeners.delete(fn);
  }

  state(): EngineState {
    return {
      playing: this.playing,
      position: this.position(),
      recording: !!this.capture,
      recordSeconds: this.capture ? this.ctx.currentTime - this.recordStartCtx : 0,
    };
  }

  private emit() {
    const s = this.state();
    for (const l of this.listeners) l(s);
  }

  position(): number {
    if (!this.playing) return this.pausedPos;
    return this.startPos + (this.ctx.currentTime - this.startCtx);
  }

  get composition(): Composition {
    return this.comp;
  }

  /**
   * Accept a new composition. Knob-only changes (gain/EQ/filter/mute/solo)
   * are applied live; anything structural (clip positions, lanes, bpm)
   * restarts playback from the current position so the schedule is rebuilt.
   */
  setComposition(next: Composition) {
    const prev = this.comp;
    this.comp = next;
    if (!this.playing) return;
    if (structurallyEqual(prev, next)) {
      this.applyLanes();
    } else {
      const pos = this.position();
      this.stopChains();
      this.startFrom(pos);
    }
  }

  async play(from?: number) {
    if (this.ctx.state === "suspended") await this.ctx.resume();
    const pos = from ?? this.pausedPos;
    await this.preload();
    this.stopChains();
    this.startFrom(pos);
    this.tick();
  }

  pause() {
    if (!this.playing) return;
    this.pausedPos = this.position();
    this.stopChains();
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.emit();
  }

  stop() {
    this.pause();
    this.pausedPos = 0;
    this.emit();
  }

  seek(pos: number) {
    pos = Math.max(0, pos);
    if (this.playing) {
      this.stopChains();
      this.startFrom(pos);
    } else {
      this.pausedPos = pos;
      this.emit();
    }
  }

  async preload(): Promise<void> {
    await Promise.all(this.comp.lanes.map((l) => this.loader.load(l.track.track_id)));
  }

  private startFrom(pos: number) {
    const at = this.ctx.currentTime + 0.05;
    this.startPos = pos;
    this.startCtx = at;
    this.playing = true;
    for (const clip of this.comp.clips) {
      const lane = this.comp.lanes.find((l) => l.id === clip.laneId);
      if (!lane) continue;
      const buf = this.loader.get(lane.track.track_id);
      if (!buf) continue;
      const rate = laneRate(lane, this.comp.masterBpm);
      if (clipEnd(clip, rate) <= pos) continue;
      const chain = buildClipChain(this.ctx, buf, this.master);
      applyLane(chain, lane, rate, laneAudible(lane, this.comp.lanes), at, 0);
      if (scheduleClip(chain, clip, rate, pos, at)) {
        this.chains.set(clip.id, chain);
      } else {
        chain.disconnect();
      }
    }
    this.emit();
  }

  private applyLanes() {
    const now = this.ctx.currentTime;
    for (const [clipId, chain] of this.chains) {
      const clip = this.comp.clips.find((c) => c.id === clipId);
      const lane = clip && this.comp.lanes.find((l) => l.id === clip.laneId);
      if (!lane) continue;
      applyLane(
        chain,
        lane,
        laneRate(lane, this.comp.masterBpm),
        laneAudible(lane, this.comp.lanes),
        now,
      );
    }
  }

  private stopChains() {
    for (const c of this.chains.values()) c.disconnect();
    this.chains.clear();
  }

  private tick = () => {
    if (!this.playing) return;
    const len = compositionLength(this.comp);
    if (len > 0 && this.position() >= len + 0.05) {
      this.pause();
      this.pausedPos = len;
      this.emit();
      return;
    }
    this.emit();
    this.raf = requestAnimationFrame(this.tick);
  };

  /** Latest master-bus level, 0..1, for the meter. */
  level(): number {
    const data = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(data);
    let peak = 0;
    for (let i = 0; i < data.length; i++) {
      const v = Math.abs(data[i]);
      if (v > peak) peak = v;
    }
    return peak;
  }

  // ---- Live recording --------------------------------------------------

  async startRecording() {
    if (this.capture) return;
    if (this.ctx.state === "suspended") await this.ctx.resume();
    const cap = new PcmCapture(this.ctx, 2);
    const node = await cap.start();
    this.master.connect(node);
    this.capture = cap;
    this.recordStartCtx = this.ctx.currentTime;
    this.emit();
  }

  /** Stop the live capture and return a WAV of everything heard since start. */
  stopRecording(): ArrayBuffer | null {
    const cap = this.capture;
    if (!cap) return null;
    const input = cap.input;
    if (input) this.master.disconnect(input);
    const { channels, sampleRate } = cap.stop();
    cap.dispose();
    this.capture = null;
    this.emit();
    if (channels[0].length === 0) return null;
    return encodeWav(channels, sampleRate);
  }

  // ---- Offline bounce --------------------------------------------------

  /**
   * Render the whole arrangement sample-accurately, faster than realtime.
   * The realtime context keeps playing untouched.
   */
  async bounce(onProgress?: (frac: number) => void): Promise<ArrayBuffer> {
    const comp = this.comp;
    const length = compositionLength(comp);
    if (length <= 0) throw new Error("Nothing to bounce: the timeline is empty");
    await this.preload();
    const sr = this.ctx.sampleRate;
    const frames = Math.ceil(length * sr) + sr; // 1s tail for filter/fade decay
    const off = new OfflineAudioContext(2, frames, sr);
    const master = off.createGain();
    master.connect(off.destination);
    for (const clip of comp.clips) {
      const lane = comp.lanes.find((l) => l.id === clip.laneId);
      if (!lane) continue;
      const buf = this.loader.get(lane.track.track_id);
      if (!buf) continue;
      const rate = laneRate(lane, comp.masterBpm);
      const chain = buildClipChain(off, buf, master);
      applyLane(chain, lane, rate, laneAudible(lane, comp.lanes), 0, 0);
      scheduleClip(chain, clip, rate, 0, 0);
    }
    if (onProgress) {
      const step = Math.max(1, Math.floor(frames / 20));
      for (let f = step; f < frames; f += step) {
        const frac = f / frames;
        off.suspend(f / sr).then(() => {
          onProgress(frac);
          off.resume();
        });
      }
    }
    const rendered = await off.startRendering();
    const trimmed = trimSilenceTail(rendered, Math.ceil(length * sr));
    onProgress?.(1);
    return encodeWav(trimmed, sr);
  }

  dispose() {
    this.pause();
    this.capture?.dispose();
    this.ctx.close();
  }
}

/** Keep the arranged length plus any audible tail, dropping trailing digital silence. */
function trimSilenceTail(buf: AudioBuffer, minFrames: number): Float32Array[] {
  const chans: Float32Array[] = [];
  for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
  let end = buf.length;
  const thresh = 1e-4;
  while (end > minFrames) {
    let silent = true;
    for (const ch of chans) {
      if (Math.abs(ch[end - 1]) > thresh) {
        silent = false;
        break;
      }
    }
    if (!silent) break;
    end--;
  }
  return chans.map((ch) => ch.subarray(0, end));
}

/** True when only lane knob values differ (no clip/lane/tempo changes). */
export function structurallyEqual(a: Composition, b: Composition): boolean {
  if (a.masterBpm !== b.masterBpm) return false;
  if (a.clips.length !== b.clips.length || a.lanes.length !== b.lanes.length) return false;
  for (let i = 0; i < a.clips.length; i++) {
    const x = a.clips[i];
    const y = b.clips[i];
    if (
      x.id !== y.id ||
      x.laneId !== y.laneId ||
      x.start !== y.start ||
      x.offset !== y.offset ||
      x.length !== y.length ||
      x.fadeIn !== y.fadeIn ||
      x.fadeOut !== y.fadeOut
    ) {
      return false;
    }
  }
  for (let i = 0; i < a.lanes.length; i++) {
    const x = a.lanes[i];
    const y = b.lanes[i];
    if (x.id !== y.id || x.track.track_id !== y.track.track_id || x.sync !== y.sync) {
      return false;
    }
  }
  return true;
}
