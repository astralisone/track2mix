import * as React from "react";
import type { AudioLoader } from "@/audio/loader";
import {
  barSeconds,
  clipDuration,
  gridForZoom,
  laneRate,
  normalizeFades,
  snapTime,
  type Clip,
  type Composition,
} from "@/audio/model";
import { keyRelation, RELATION_TONE } from "@/audio/camelot";
import { LANE_HEIGHT } from "./LaneStrip";

export const RULER_HEIGHT = 26;
const HANDLE_PX = 8;
const PEAK_BUCKETS = 4096;

type DragMode = "move" | "trim-start" | "trim-end" | "fade-in" | "fade-out";

type Drag = {
  mode: DragMode;
  clipId: string;
  startX: number;
  original: Clip;
  rate: number;
};

type Props = {
  comp: Composition;
  loader: AudioLoader;
  pxPerSec: number;
  position: number;
  referenceKey: string | null;
  selectedClipId: string | null;
  /** Bumped by the parent whenever a buffer finishes decoding so peaks redraw. */
  revision: number;
  onSeek: (t: number) => void;
  onClipChange: (clip: Clip) => void;
  onSelectClip: (id: string | null) => void;
  onDeleteClip: (id: string) => void;
  onZoom: (pxPerSec: number) => void;
};

/**
 * Canvas timeline: a bar ruler, one row per lane, clips drawn with their
 * waveform, fades and key-relation colour. Drag a clip body to move it,
 * its edges to trim, the small squares at its top corners to set fades.
 */
export function Timeline({
  comp,
  loader,
  pxPerSec,
  position,
  referenceKey,
  selectedClipId,
  revision,
  onSeek,
  onClipChange,
  onSelectClip,
  onDeleteClip,
  onZoom,
}: Props) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const [drag, setDrag] = React.useState<Drag | null>(null);
  const [hover, setHover] = React.useState<DragMode | "ruler" | null>(null);
  const [viewportW, setViewportW] = React.useState(800);

  const rates = React.useMemo(
    () => new Map(comp.lanes.map((l) => [l.id, laneRate(l, comp.masterBpm)])),
    [comp.lanes, comp.masterBpm],
  );

  const contentSeconds = React.useMemo(() => {
    let end = 0;
    for (const c of comp.clips) end = Math.max(end, c.start + clipDuration(c, rates.get(c.laneId) ?? 1));
    return Math.max(end + 30, position + 30, viewportW / pxPerSec);
  }, [comp.clips, rates, position, viewportW, pxPerSec]);

  const width = Math.ceil(contentSeconds * pxPerSec);
  const height = RULER_HEIGHT + Math.max(1, comp.lanes.length) * LANE_HEIGHT;

  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewportW(el.clientWidth));
    ro.observe(el);
    setViewportW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // Keep the playhead in view while playing.
  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const x = position * pxPerSec;
    if (x < el.scrollLeft || x > el.scrollLeft + el.clientWidth - 40) {
      el.scrollLeft = Math.max(0, x - el.clientWidth * 0.2);
    }
  }, [position, pxPerSec]);

  // ---- drawing ---------------------------------------------------------
  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    drawGrid(ctx, comp, pxPerSec, width, height);

    comp.lanes.forEach((lane, i) => {
      const y = RULER_HEIGHT + i * LANE_HEIGHT;
      const rate = rates.get(lane.id) ?? 1;
      const tone = RELATION_TONE[keyRelation(referenceKey, lane.track.camelot)];
      const peaks = loader.peaks(lane.track.track_id, PEAK_BUCKETS);
      const buf = loader.get(lane.track.track_id);
      for (const clip of comp.clips) {
        if (clip.laneId !== lane.id) continue;
        drawClip(ctx, clip, rate, y, pxPerSec, tone.stroke, peaks, buf?.duration ?? 0, clip.id === selectedClipId, lane.mute);
      }
    });

    // Playhead
    const px = position * pxPerSec;
    ctx.strokeStyle = "#FFD156";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(px + 0.5, 0);
    ctx.lineTo(px + 0.5, height);
    ctx.stroke();
    ctx.fillStyle = "#FFD156";
    ctx.beginPath();
    ctx.moveTo(px - 5, 0);
    ctx.lineTo(px + 5, 0);
    ctx.lineTo(px, 7);
    ctx.closePath();
    ctx.fill();
  }, [comp, rates, pxPerSec, width, height, position, referenceKey, selectedClipId, loader, revision]);

  // ---- hit testing -----------------------------------------------------
  function localPoint(e: React.MouseEvent): { x: number; y: number } {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function hitTest(x: number, y: number): { clip: Clip; mode: DragMode; rate: number } | null {
    if (y < RULER_HEIGHT) return null;
    const laneIdx = Math.floor((y - RULER_HEIGHT) / LANE_HEIGHT);
    const lane = comp.lanes[laneIdx];
    if (!lane) return null;
    const rate = rates.get(lane.id) ?? 1;
    const t = x / pxPerSec;
    const laneY = y - RULER_HEIGHT - laneIdx * LANE_HEIGHT;
    // Topmost (last drawn) clip wins.
    for (let i = comp.clips.length - 1; i >= 0; i--) {
      const clip = comp.clips[i];
      if (clip.laneId !== lane.id) continue;
      const dur = clipDuration(clip, rate);
      if (t < clip.start || t > clip.start + dur) continue;
      const x0 = clip.start * pxPerSec;
      const x1 = (clip.start + dur) * pxPerSec;
      if (laneY < 14) {
        const fiX = x0 + clip.fadeIn * pxPerSec;
        const foX = x1 - clip.fadeOut * pxPerSec;
        if (Math.abs(x - fiX) <= HANDLE_PX) return { clip, mode: "fade-in", rate };
        if (Math.abs(x - foX) <= HANDLE_PX) return { clip, mode: "fade-out", rate };
      }
      if (x - x0 <= HANDLE_PX) return { clip, mode: "trim-start", rate };
      if (x1 - x <= HANDLE_PX) return { clip, mode: "trim-end", rate };
      return { clip, mode: "move", rate };
    }
    return null;
  }

  function onMouseDown(e: React.MouseEvent) {
    if (e.button !== 0) return;
    const { x, y } = localPoint(e);
    if (y < RULER_HEIGHT) {
      onSeek(maybeSnap(x / pxPerSec, e.altKey));
      return;
    }
    const hit = hitTest(x, y);
    if (!hit) {
      onSelectClip(null);
      onSeek(maybeSnap(x / pxPerSec, e.altKey));
      return;
    }
    onSelectClip(hit.clip.id);
    setDrag({ mode: hit.mode, clipId: hit.clip.id, startX: x, original: hit.clip, rate: hit.rate });
  }

  function maybeSnap(t: number, bypass: boolean): number {
    if (!comp.snap || bypass) return Math.max(0, t);
    return snapTime(t, comp.masterBpm, gridForZoom(comp.masterBpm, pxPerSec));
  }

  function onMouseMove(e: React.MouseEvent) {
    const { x, y } = localPoint(e);
    if (!drag) {
      if (y < RULER_HEIGHT) setHover("ruler");
      else setHover(hitTest(x, y)?.mode ?? null);
      return;
    }
    const dt = (x - drag.startX) / pxPerSec;
    const o = drag.original;
    const rate = drag.rate;
    const dur = clipDuration(o, rate);
    let next: Clip = o;
    switch (drag.mode) {
      case "move":
        next = { ...o, start: maybeSnap(o.start + dt, e.altKey) };
        break;
      case "trim-start": {
        // Move the left edge; keep the right edge where it is.
        const newStart = Math.min(maybeSnap(o.start + dt, e.altKey), o.start + dur - 0.25);
        const delta = newStart - o.start; // timeline seconds
        const srcDelta = delta * rate;
        const offset = Math.max(0, o.offset + srcDelta);
        const consumed = offset - o.offset;
        next = { ...o, start: o.start + consumed / rate, offset, length: o.length - consumed };
        break;
      }
      case "trim-end": {
        const newEnd = Math.max(maybeSnap(o.start + dur + dt, e.altKey), o.start + 0.25);
        const maxLen = Math.max(0.25, (sourceDuration(o.laneId) - o.offset));
        next = { ...o, length: Math.min(maxLen, (newEnd - o.start) * rate) };
        break;
      }
      case "fade-in":
        next = { ...o, fadeIn: Math.max(0, o.fadeIn + dt) };
        break;
      case "fade-out":
        next = { ...o, fadeOut: Math.max(0, o.fadeOut - dt) };
        break;
    }
    onClipChange(normalizeFades(next, rate));
  }

  function sourceDuration(laneId: string): number {
    const lane = comp.lanes.find((l) => l.id === laneId);
    return lane ? (loader.get(lane.track.track_id)?.duration ?? Infinity) : Infinity;
  }

  function endDrag() {
    setDrag(null);
  }

  function onWheel(e: React.WheelEvent) {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const el = scrollRef.current;
    const { x } = localPoint(e);
    const t = x / pxPerSec;
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const next = Math.min(400, Math.max(2, pxPerSec * factor));
    onZoom(next);
    if (el) {
      // Keep the time under the cursor stationary.
      const rect = canvasRef.current!.getBoundingClientRect();
      const cursorInView = e.clientX - rect.left - el.scrollLeft + el.scrollLeft;
      el.scrollLeft = Math.max(0, t * next - (cursorInView - el.scrollLeft));
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if ((e.key === "Delete" || e.key === "Backspace") && selectedClipId) {
      e.preventDefault();
      onDeleteClip(selectedClipId);
    }
  }

  const cursor =
    drag?.mode === "move" || hover === "move"
      ? "grab"
      : drag?.mode?.startsWith("trim") || hover?.startsWith("trim")
        ? "ew-resize"
        : drag?.mode?.startsWith("fade") || hover?.startsWith("fade")
          ? "ns-resize"
          : hover === "ruler"
            ? "text"
            : "default";

  return (
    <div
      ref={scrollRef}
      className="relative flex-1 min-w-0 overflow-x-auto overflow-y-hidden outline-none"
      tabIndex={0}
      onKeyDown={onKeyDown}
      onWheel={onWheel}
    >
      <canvas
        ref={canvasRef}
        style={{ cursor, display: "block" }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={endDrag}
        onMouseLeave={() => {
          endDrag();
          setHover(null);
        }}
      />
      {comp.lanes.length === 0 && (
        <div className="absolute inset-0 top-[26px] flex items-center justify-center pointer-events-none">
          <div className="text-xs text-muted-foreground text-center max-w-xs">
            Add tracks from the library to start composing. Lanes are coloured by
            how their key relates to the first lane.
          </div>
        </div>
      )}
    </div>
  );
}

function drawGrid(
  ctx: CanvasRenderingContext2D,
  comp: Composition,
  pxPerSec: number,
  width: number,
  height: number,
) {
  // Ruler background
  ctx.fillStyle = "rgba(255,255,255,0.02)";
  ctx.fillRect(0, 0, width, RULER_HEIGHT);
  ctx.fillStyle = "rgba(255,255,255,0.06)";
  ctx.fillRect(0, RULER_HEIGHT - 1, width, 1);

  // Lane separators
  for (let i = 1; i <= comp.lanes.length; i++) {
    const y = RULER_HEIGHT + i * LANE_HEIGHT - 0.5;
    ctx.fillStyle = "rgba(255,255,255,0.06)";
    ctx.fillRect(0, y, width, 1);
  }

  const bar = barSeconds(comp.masterBpm);
  const grid = gridForZoom(comp.masterBpm, pxPerSec);
  const labelEvery = Math.max(1, Math.round(80 / (bar * pxPerSec))); // bars between labels
  ctx.font = "10px JetBrains Mono, ui-monospace, monospace";
  ctx.textBaseline = "top";
  for (let t = 0; t <= width / pxPerSec; t += grid) {
    const x = Math.round(t * pxPerSec) + 0.5;
    const barIdx = Math.round(t / bar);
    const onBar = Math.abs(t / bar - barIdx) < 1e-6;
    ctx.strokeStyle = onBar ? "rgba(255,255,255,0.10)" : "rgba(255,255,255,0.04)";
    ctx.beginPath();
    ctx.moveTo(x, onBar ? 10 : RULER_HEIGHT - 6);
    ctx.lineTo(x, height);
    ctx.stroke();
    if (onBar && barIdx % labelEvery === 0) {
      ctx.fillStyle = "rgba(158,164,178,0.9)";
      ctx.fillText(String(barIdx + 1), x + 3, 2);
    }
  }
}

function drawClip(
  ctx: CanvasRenderingContext2D,
  clip: Clip,
  rate: number,
  laneY: number,
  pxPerSec: number,
  color: string,
  peaks: Float32Array | null,
  sourceDuration: number,
  selected: boolean,
  muted: boolean,
) {
  const x0 = clip.start * pxPerSec;
  const dur = clipDuration(clip, rate);
  const w = Math.max(2, dur * pxPerSec);
  const y0 = laneY + 4;
  const h = LANE_HEIGHT - 8;

  ctx.save();
  ctx.globalAlpha = muted ? 0.45 : 1;
  roundRect(ctx, x0, y0, w, h, 5);
  ctx.fillStyle = hexWithAlpha(color, 0.13);
  ctx.fill();
  ctx.clip();

  // Waveform: pixel column → source time → peak bucket.
  if (peaks && sourceDuration > 0) {
    const mid = y0 + h / 2 + 6;
    const amp = (h - 22) / 2;
    ctx.fillStyle = hexWithAlpha(color, 0.75);
    const startPx = Math.max(0, Math.floor(x0));
    const endPx = Math.ceil(x0 + w);
    for (let px = startPx; px < endPx; px++) {
      const tl = (px - x0) / pxPerSec; // timeline seconds into clip
      const src = clip.offset + tl * rate;
      const b = Math.floor((src / sourceDuration) * peaks.length);
      if (b < 0 || b >= peaks.length) continue;
      const p = peaks[b] * amp;
      ctx.fillRect(px, mid - p, 1, Math.max(1, p * 2));
    }
  }

  // Fade shading
  ctx.fillStyle = "rgba(1,2,15,0.55)";
  if (clip.fadeIn > 0) {
    const fw = clip.fadeIn * pxPerSec;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x0 + fw, y0);
    ctx.lineTo(x0, y0 + h);
    ctx.closePath();
    ctx.fill();
  }
  if (clip.fadeOut > 0) {
    const fw = clip.fadeOut * pxPerSec;
    ctx.beginPath();
    ctx.moveTo(x0 + w, y0);
    ctx.lineTo(x0 + w - fw, y0);
    ctx.lineTo(x0 + w, y0 + h);
    ctx.closePath();
    ctx.fill();
  }

  // Fade handles
  ctx.fillStyle = "#E1E1E3";
  ctx.fillRect(x0 + clip.fadeIn * pxPerSec - 3, y0 + 2, 6, 6);
  ctx.fillRect(x0 + w - clip.fadeOut * pxPerSec - 3, y0 + 2, 6, 6);

  ctx.restore();

  ctx.save();
  ctx.globalAlpha = muted ? 0.5 : 1;
  roundRect(ctx, x0 + 0.5, y0 + 0.5, w - 1, h - 1, 5);
  ctx.strokeStyle = selected ? "#FFD156" : hexWithAlpha(color, 0.6);
  ctx.lineWidth = selected ? 1.5 : 1;
  ctx.stroke();
  // Trim handles
  ctx.fillStyle = hexWithAlpha(color, 0.5);
  ctx.fillRect(x0, y0 + h / 2 - 10, 3, 20);
  ctx.fillRect(x0 + w - 3, y0 + h / 2 - 10, 3, 20);
  ctx.restore();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

function hexWithAlpha(hex: string, a: number): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})`;
}
