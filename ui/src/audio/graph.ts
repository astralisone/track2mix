import { EQ_KILL, HP_MIN, LP_MAX, type Clip, type Lane } from "./model";

/**
 * Per-clip processing chain, identical for the realtime and offline graphs:
 *
 *   source → fade gain → HP → LP → low shelf → mid peak → high shelf → lane gain → out
 */
export type ClipChain = {
  source: AudioBufferSourceNode;
  fade: GainNode;
  hp: BiquadFilterNode;
  lp: BiquadFilterNode;
  low: BiquadFilterNode;
  mid: BiquadFilterNode;
  high: BiquadFilterNode;
  gain: GainNode;
  disconnect: () => void;
};

export function buildClipChain(
  ctx: BaseAudioContext,
  buffer: AudioBuffer,
  out: AudioNode,
): ClipChain {
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const fade = ctx.createGain();
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.Q.value = 0.707;
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.Q.value = 0.707;
  const low = ctx.createBiquadFilter();
  low.type = "lowshelf";
  low.frequency.value = 200;
  const mid = ctx.createBiquadFilter();
  mid.type = "peaking";
  mid.frequency.value = 1200;
  mid.Q.value = 0.9;
  const high = ctx.createBiquadFilter();
  high.type = "highshelf";
  high.frequency.value = 5000;
  const gain = ctx.createGain();

  source.connect(fade);
  fade.connect(hp);
  hp.connect(lp);
  lp.connect(low);
  low.connect(mid);
  mid.connect(high);
  high.connect(gain);
  gain.connect(out);

  const disconnect = () => {
    try {
      source.stop();
    } catch {
      /* not started */
    }
    for (const n of [source, fade, hp, lp, low, mid, high, gain]) n.disconnect();
  };
  return { source, fade, hp, lp, low, mid, high, gain, disconnect };
}

/** Push a lane's current knob values onto a chain, smoothed over `ramp` seconds. */
export function applyLane(
  chain: ClipChain,
  lane: Lane,
  rate: number,
  audible: boolean,
  now: number,
  ramp = 0.02,
) {
  const set = (p: AudioParam, v: number) => {
    p.cancelScheduledValues(now);
    p.setTargetAtTime(v, now, ramp);
  };
  set(chain.gain.gain, audible ? lane.gain : 0);
  set(chain.hp.frequency, Math.max(HP_MIN, lane.hp));
  set(chain.lp.frequency, Math.min(LP_MAX, lane.lp));
  set(chain.low.gain, Math.max(EQ_KILL, lane.eqLow));
  set(chain.mid.gain, Math.max(EQ_KILL, lane.eqMid));
  set(chain.high.gain, Math.max(EQ_KILL, lane.eqHigh));
  chain.source.playbackRate.setValueAtTime(rate, now);
}

/**
 * Schedule a clip to play so that timeline position `from` lines up with
 * context time `at`. Returns false when the clip is entirely before `from`.
 * `rate` is the lane's playback rate; fades are expressed in timeline seconds.
 */
export function scheduleClip(
  chain: ClipChain,
  clip: Clip,
  rate: number,
  from: number,
  at: number,
): boolean {
  const dur = clip.length / rate;
  const end = clip.start + dur;
  if (end <= from) return false;

  // Where in the clip (timeline seconds) do we begin?
  const skip = Math.max(0, from - clip.start);
  const startAt = at + Math.max(0, clip.start - from);
  const sourceOffset = clip.offset + skip * rate;
  const sourceRemaining = clip.length - skip * rate;
  if (sourceRemaining <= 0) return false;

  chain.source.playbackRate.value = rate;
  chain.source.start(startAt, sourceOffset, sourceRemaining);

  // Fade envelope in context time.
  const g = chain.fade.gain;
  const clipAt = (tl: number) => at + (tl - from); // timeline → ctx time
  g.cancelScheduledValues(0);
  const fadeInEnd = clip.start + clip.fadeIn;
  const fadeOutStart = end - clip.fadeOut;

  // Initial value at `startAt`.
  let g0 = 1;
  const tl0 = Math.max(clip.start, from);
  if (clip.fadeIn > 0 && tl0 < fadeInEnd) g0 = (tl0 - clip.start) / clip.fadeIn;
  if (clip.fadeOut > 0 && tl0 > fadeOutStart) {
    g0 = Math.min(g0, (end - tl0) / clip.fadeOut);
  }
  g.setValueAtTime(Math.max(0, Math.min(1, g0)), startAt);
  if (clip.fadeIn > 0 && fadeInEnd > tl0) {
    g.linearRampToValueAtTime(1, clipAt(fadeInEnd));
  }
  if (clip.fadeOut > 0 && fadeOutStart >= tl0) {
    g.setValueAtTime(1, clipAt(fadeOutStart));
    g.linearRampToValueAtTime(0, clipAt(end));
  } else if (clip.fadeOut > 0) {
    g.linearRampToValueAtTime(0, clipAt(end));
  }
  return true;
}
