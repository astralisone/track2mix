/**
 * Captures float PCM flowing through a point in the realtime graph so a live
 * performance can be written out as WAV. Uses an AudioWorklet (loaded from a
 * blob so no extra bundling is needed) and falls back to a ScriptProcessor
 * where worklets aren't available.
 */
const WORKLET_SRC = `
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() { super(); this.active = true;
    this.port.onmessage = (e) => { if (e.data === "stop") this.active = false; }; }
  process(inputs) {
    if (!this.active) return false;
    const input = inputs[0];
    if (input && input.length > 0) {
      const copy = input.map((ch) => ch.slice());
      this.port.postMessage(copy, copy.map((c) => c.buffer));
    } else {
      // No upstream node is actively producing (a gap between clips, or
      // record armed before play): keep time with a block of silence.
      const silent = [new Float32Array(128), new Float32Array(128)];
      this.port.postMessage(silent, silent.map((c) => c.buffer));
    }
    return true;
  }
}
registerProcessor("t2m-capture", CaptureProcessor);
`;

/**
 * The worklet module is registered once per context: a second `addModule`
 * of the same source would call `registerProcessor` with a name that is
 * already taken and reject, which used to push every recording after the
 * first onto the ScriptProcessor fallback.
 */
const workletRegistry = new WeakMap<BaseAudioContext, Promise<boolean>>();

function ensureWorkletRegistered(ctx: BaseAudioContext): Promise<boolean> {
  const existing = workletRegistry.get(ctx);
  if (existing) return existing;
  const p = (async () => {
    if (!("audioWorklet" in ctx)) return false;
    try {
      const url = URL.createObjectURL(
        new Blob([WORKLET_SRC], { type: "application/javascript" }),
      );
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      return true;
    } catch {
      return false;
    }
  })();
  workletRegistry.set(ctx, p);
  return p;
}

export class PcmCapture {
  private ctx: AudioContext;
  private node: AudioNode | null = null;
  private chunks: Float32Array[][] = [];
  private channels: number;
  private sink: GainNode;

  constructor(ctx: AudioContext, channels = 2) {
    this.ctx = ctx;
    this.channels = channels;
    // A silent sink keeps the capture node alive without doubling the output.
    this.sink = ctx.createGain();
    this.sink.gain.value = 0;
    this.sink.connect(ctx.destination);
  }

  get input(): AudioNode | null {
    return this.node;
  }

  frames(): number {
    return this.chunks.reduce((n, c) => n + (c[0]?.length ?? 0), 0);
  }

  /** Start capturing; returns the node to connect the master bus into. */
  async start(): Promise<AudioNode> {
    this.chunks = [];
    const ok = await ensureWorkletRegistered(this.ctx);
    if (ok) {
      const n = new AudioWorkletNode(this.ctx, "t2m-capture", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: this.channels,
        channelCountMode: "explicit",
      });
      n.port.onmessage = (e: MessageEvent<Float32Array[]>) => {
        if (Array.isArray(e.data) && e.data.length) this.chunks.push(e.data);
      };
      n.connect(this.sink);
      this.node = n;
      return n;
    }
    const sp = this.ctx.createScriptProcessor(4096, this.channels, this.channels);
    sp.onaudioprocess = (e) => {
      const chans: Float32Array[] = [];
      for (let c = 0; c < e.inputBuffer.numberOfChannels; c++) {
        chans.push(e.inputBuffer.getChannelData(c).slice());
      }
      this.chunks.push(chans);
    };
    sp.connect(this.sink);
    this.node = sp;
    return sp;
  }

  /** Stop and return the captured channels. */
  stop(): { channels: Float32Array[]; sampleRate: number } {
    const n = this.node;
    if (n instanceof AudioWorkletNode) {
      n.port.postMessage("stop");
      n.port.onmessage = null;
    } else if (n && "onaudioprocess" in n) {
      (n as ScriptProcessorNode).onaudioprocess = null;
    }
    n?.disconnect();
    this.node = null;
    const chunks = this.chunks;
    this.chunks = [];
    const total = chunks.reduce((s, c) => s + (c[0]?.length ?? 0), 0);
    const channels: Float32Array[] = [];
    for (let c = 0; c < this.channels; c++) {
      const arr = new Float32Array(total);
      let o = 0;
      for (const ch of chunks) {
        const src = ch[c] ?? ch[0];
        arr.set(src, o);
        o += src.length;
      }
      channels.push(arr);
    }
    return { channels, sampleRate: this.ctx.sampleRate };
  }

  dispose() {
    this.node?.disconnect();
    this.sink.disconnect();
  }
}
