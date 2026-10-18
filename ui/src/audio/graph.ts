import { EQ_KILL, HP_MIN, LP_MAX, fadeBreakpoints, fadeGainAt, type Clip, type Lane } from "./model";

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

  // Fade envelope in context time: the same breakpoints the timeline draws
  // (`fadeBreakpoints`), so overlapping fades, fades longer than the clip
  // after a tempo change, and starts inside a fade all come out monotone
  // and click-free. Events are emitted in time order, as Web Audio requires.
  const g = chain.fade.gain;
  const clipAt = (tl: number) => at + (tl - from); // timeline → ctx time
  g.cancelScheduledValues(0);
  const tl0 = Math.max(clip.start, from);
  let last = fadeGainAt(clip, rate, tl0);
  g.setValueAtTime(last, startAt);
  const points = fadeBreakpoints(clip, rate).filter((bp) => bp.t > tl0);
  // A final point at the value already held is a no-op; leave it out.
  if (points.length && points[points.length - 1].g === last && points.length === 1) points.pop();
  points.forEach((bp, i) => {
    const isLast = i === points.length - 1;
    if (isLast && bp.g === last) return;
    g.linearRampToValueAtTime(bp.g, clipAt(bp.t));
    last = bp.g;
  });
  return true;
}
