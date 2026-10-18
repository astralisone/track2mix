import { decodeTrackPcm, readTrackAudio } from "@/lib/tauri";

/**
 * Decoded-audio cache keyed by track id. Decoding a 6-minute track costs a
 * second or two and ~60MB, so every consumer (library preview, composition
 * lanes, bounce) shares one buffer per track.
 */
export class AudioLoader {
  private ctx: BaseAudioContext;
  private buffers = new Map<string, AudioBuffer>();
  private inflight = new Map<string, Promise<AudioBuffer>>();
  private peaksCache = new Map<string, Float32Array>();

  constructor(ctx: BaseAudioContext) {
    this.ctx = ctx;
  }

  get(trackId: string): AudioBuffer | undefined {
    return this.buffers.get(trackId);
  }

  has(trackId: string): boolean {
    return this.buffers.has(trackId);
  }

  async load(trackId: string): Promise<AudioBuffer> {
    const cached = this.buffers.get(trackId);
    if (cached) return cached;
    const pending = this.inflight.get(trackId);
    if (pending) return pending;
    const p = this.decode(trackId)
      .then((buf) => {
        this.buffers.set(trackId, buf);
        return buf;
      })
      .finally(() => this.inflight.delete(trackId));
    this.inflight.set(trackId, p);
    return p;
  }

  private async decode(trackId: string): Promise<AudioBuffer> {
    const bytes = await readTrackAudio(trackId);
    try {
      // decodeAudioData detaches the buffer, so pass a copy if we ever
      // need `bytes` again; we don't.
      return await this.ctx.decodeAudioData(bytes);
    } catch (webviewErr) {
      // WebKit on some platforms lacks a decoder for the format; fall back
      // to Symphonia on the Rust side (mono).
      const pcm = await decodeTrackPcm(trackId, this.ctx.sampleRate).catch(
        (rustErr) => {
          throw new Error(
            `webview decode failed (${String(webviewErr)}); rust decode failed (${String(rustErr)})`,
          );
        },
      );
      if (pcm.samples.length === 0) {
        throw new Error(`rust decode produced 0 samples for track ${trackId}`);
      }
      const buf = this.ctx.createBuffer(1, pcm.samples.length, pcm.sampleRate);
      // Copy into the buffer's own channel storage; `copyToChannel` wants a
      // Float32Array backed by a plain ArrayBuffer and the IPC view may not be.
      buf.getChannelData(0).set(pcm.samples);
      return buf;
    }
  }

  /**
   * Forget every decoded buffer. Called when a different library is opened:
   * Rekordbox numbers track ids from 1 in every export, so the same id can
   * name a different file in the next database. In-flight decodes settle
   * into the map afterwards but are keyed by the old id; `evict` them by
   * clearing again if that matters, which it doesn't for a library switch.
   */
  clear() {
    this.buffers.clear();
    this.peaksCache.clear();
  }

  evict(trackId: string) {
    this.buffers.delete(trackId);
    for (const k of Array.from(this.peaksCache.keys())) {
      if (k.startsWith(`${trackId}:`)) this.peaksCache.delete(k);
    }
  }

  /** Max-abs peaks over `buckets` equal slices of the whole buffer (mono-summed). */
  peaks(trackId: string, buckets: number): Float32Array | null {
    const buf = this.buffers.get(trackId);
    if (!buf) return null;
    const key = `${trackId}:${buckets}`;
    const cached = this.peaksCache.get(key);
    if (cached) return cached;
    const out = computePeaks(buf, buckets);
    this.peaksCache.set(key, out);
    return out;
  }
}

export function computePeaks(buf: AudioBuffer, buckets: number): Float32Array {
  const out = new Float32Array(buckets);
  const len = buf.length;
  if (len === 0 || buckets === 0) return out;
  const chans: Float32Array[] = [];
  for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
  const per = len / buckets;
  for (let b = 0; b < buckets; b++) {
    const s = Math.floor(b * per);
    const e = Math.min(len, Math.floor((b + 1) * per));
    let peak = 0;
    // Stride through long buckets: peaks are for display, not analysis.
    const stride = Math.max(1, Math.floor((e - s) / 512));
    for (let i = s; i < e; i += stride) {
      let v = 0;
      for (const ch of chans) v += Math.abs(ch[i]);
      v /= chans.length;
      if (v > peak) peak = v;
    }
    out[b] = peak;
  }
  return out;
}
