import type { UiTrack } from "@/lib/tauri";
import {
  DEFAULT_LANE,
  EQ_KILL,
  HP_MIN,
  LP_MAX,
  type Clip,
  type Composition,
  type Lane,
} from "./model";

/**
 * Composition project files. A `.t2m` is JSON: the arrangement plus a
 * snapshot of every lane's library track, so the file can be reopened
 * against a re-exported library (Rekordbox renumbers track ids on every
 * export) by matching on file path or name/artist instead of the id.
 */
export const PROJECT_EXT = "t2m";
export const PROJECT_FORMAT = "track2mix-composition";
export const PROJECT_VERSION = 1;
export const UNTITLED = "Untitled mix";

export type SavedLane = Omit<Lane, "track" | "seeded"> & { track: UiTrack };

export type ProjectFile = {
  format: typeof PROJECT_FORMAT;
  version: number;
  name: string;
  /** ISO-8601 time of the save. */
  savedAt: string;
  /** Library DB the lanes were resolved against when saved. */
  library: string | null;
  composition: {
    masterBpm: number;
    snap: boolean;
    lanes: SavedLane[];
    clips: Clip[];
  };
};

export type ProjectMeta = {
  name: string;
  library: string | null;
  /** Injectable for tests. */
  now?: Date;
};

function savedLane(l: Lane): SavedLane {
  return {
    id: l.id,
    track: { ...l.track },
    gain: l.gain,
    eqLow: l.eqLow,
    eqMid: l.eqMid,
    eqHigh: l.eqHigh,
    hp: l.hp,
    lp: l.lp,
    sync: l.sync,
    mute: l.mute,
    solo: l.solo,
  };
}

function savedClip(c: Clip): Clip {
  const out: Clip = {
    id: c.id,
    laneId: c.laneId,
    start: c.start,
    offset: c.offset,
    length: c.length,
    fadeIn: c.fadeIn,
    fadeOut: c.fadeOut,
  };
  if (c.fadeInAuto !== undefined) out.fadeInAuto = c.fadeInAuto;
  if (c.fadeOutAuto !== undefined) out.fadeOutAuto = c.fadeOutAuto;
  return out;
}

export function toProjectFile(comp: Composition, meta: ProjectMeta): ProjectFile {
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    name: meta.name.trim() || UNTITLED,
    savedAt: (meta.now ?? new Date()).toISOString(),
    library: meta.library,
    composition: {
      masterBpm: comp.masterBpm,
      snap: comp.snap,
      lanes: comp.lanes.map(savedLane),
      clips: comp.clips.map(savedClip),
    },
  };
}

export function serializeProject(comp: Composition, meta: ProjectMeta): string {
  return JSON.stringify(toProjectFile(comp, meta), null, 2) + "\n";
}

// ---- parsing ------------------------------------------------------------

class ProjectError extends Error {}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown, what: string): string {
  if (typeof v !== "string") throw new ProjectError(`${what} must be a string`);
  return v;
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function num(v: unknown, what: string, fallback?: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    if (fallback !== undefined) return fallback;
    throw new ProjectError(`${what} must be a finite number`);
  }
  return v;
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function parseTrack(v: unknown, where: string): UiTrack {
  if (!isObj(v)) throw new ProjectError(`${where}: track must be an object`);
  return {
    track_id: str(v.track_id, `${where}: track.track_id`),
    name: typeof v.name === "string" ? v.name : "",
    artist: typeof v.artist === "string" ? v.artist : "",
    genre: typeof v.genre === "string" ? v.genre : "",
    sub_genre: strOrNull(v.sub_genre),
    bpm: numOrNull(v.bpm),
    tonality: typeof v.tonality === "string" ? v.tonality : "",
    camelot: strOrNull(v.camelot),
    energy_raw: numOrNull(v.energy_raw),
    energy: numOrNull(v.energy),
    file_path: strOrNull(v.file_path),
  };
}

function parseLane(v: unknown, i: number): SavedLane {
  const where = `lanes[${i}]`;
  if (!isObj(v)) throw new ProjectError(`${where} must be an object`);
  return {
    id: str(v.id, `${where}.id`),
    track: parseTrack(v.track, where),
    gain: clamp(num(v.gain, `${where}.gain`, DEFAULT_LANE.gain), 0, 1.5),
    eqLow: clamp(num(v.eqLow, `${where}.eqLow`, 0), EQ_KILL, 12),
    eqMid: clamp(num(v.eqMid, `${where}.eqMid`, 0), EQ_KILL, 12),
    eqHigh: clamp(num(v.eqHigh, `${where}.eqHigh`, 0), EQ_KILL, 12),
    hp: clamp(num(v.hp, `${where}.hp`, HP_MIN), HP_MIN, LP_MAX),
    lp: clamp(num(v.lp, `${where}.lp`, LP_MAX), HP_MIN, LP_MAX),
    sync: bool(v.sync, DEFAULT_LANE.sync),
    mute: bool(v.mute, false),
    solo: bool(v.solo, false),
  };
}

function parseClip(v: unknown, i: number): Clip {
  const where = `clips[${i}]`;
  if (!isObj(v)) throw new ProjectError(`${where} must be an object`);
  const length = num(v.length, `${where}.length`);
  if (length <= 0) throw new ProjectError(`${where}.length must be positive`);
  const clip: Clip = {
    id: str(v.id, `${where}.id`),
    laneId: str(v.laneId, `${where}.laneId`),
    start: Math.max(0, num(v.start, `${where}.start`)),
    offset: Math.max(0, num(v.offset, `${where}.offset`, 0)),
    length,
    fadeIn: Math.max(0, num(v.fadeIn, `${where}.fadeIn`, 0)),
    fadeOut: Math.max(0, num(v.fadeOut, `${where}.fadeOut`, 0)),
  };
  if (typeof v.fadeInAuto === "boolean") clip.fadeInAuto = v.fadeInAuto;
  if (typeof v.fadeOutAuto === "boolean") clip.fadeOutAuto = v.fadeOutAuto;
  return clip;
}

/** Parse and validate a project file. Throws with a reason a user can act on. */
export function parseProject(text: string): ProjectFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ProjectError(`not valid JSON: ${String(e)}`);
  }
  if (!isObj(raw)) throw new ProjectError("not a project object");
  if (raw.format !== PROJECT_FORMAT) {
    throw new ProjectError(`not a Track2Mix composition (format: ${String(raw.format)})`);
  }
  const version = num(raw.version, "version");
  if (version > PROJECT_VERSION) {
    throw new ProjectError(
      `saved by a newer Track2Mix (file version ${version}, this app reads up to ${PROJECT_VERSION})`,
    );
  }
  const compRaw = raw.composition;
  if (!isObj(compRaw)) throw new ProjectError("missing composition");
  if (!Array.isArray(compRaw.lanes)) throw new ProjectError("composition.lanes must be an array");
  if (!Array.isArray(compRaw.clips)) throw new ProjectError("composition.clips must be an array");
  const lanes = compRaw.lanes.map(parseLane);
  const clips = compRaw.clips.map(parseClip);
  const ids = new Set<string>();
  for (const l of lanes) {
    if (ids.has(l.id)) throw new ProjectError(`duplicate lane id ${l.id}`);
    ids.add(l.id);
  }
  const masterBpm = num(compRaw.masterBpm, "composition.masterBpm");
  if (masterBpm < 40 || masterBpm > 300) {
    throw new ProjectError(`composition.masterBpm ${masterBpm} is outside 40–300`);
  }
  return {
    format: PROJECT_FORMAT,
    version,
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name : UNTITLED,
    savedAt: typeof raw.savedAt === "string" ? raw.savedAt : "",
    library: strOrNull(raw.library),
    composition: { masterBpm, snap: bool(compRaw.snap, true), lanes, clips },
  };
}

// ---- resolving against a library ---------------------------------------

export type MissingLane = { lane: SavedLane; reason: string };

export type ResolveResult = {
  comp: Composition;
  /** Lanes that had no playable track in this library; their clips are dropped too. */
  missing: MissingLane[];
};

/**
 * Find the library track for a saved lane. The id wins when it still names
 * the same file (or the file was never known); otherwise the file path,
 * then name + artist. Ids are checked against the snapshot because a
 * re-exported library reuses them for different tracks.
 */
export function resolveTrack(saved: UiTrack, tracks: UiTrack[]): UiTrack | null {
  const byId = tracks.find((t) => t.track_id === saved.track_id);
  if (byId) {
    const samePath = !!saved.file_path && byId.file_path === saved.file_path;
    const sameName = byId.name === saved.name && byId.artist === saved.artist;
    if (samePath || sameName || (!saved.file_path && !saved.name)) return byId;
  }
  if (saved.file_path) {
    const byPath = tracks.find((t) => t.file_path === saved.file_path);
    if (byPath) return byPath;
  }
  if (saved.name) {
    const byName = tracks.find((t) => t.name === saved.name && t.artist === saved.artist);
    if (byName) return byName;
  }
  return null;
}

export function resolveProject(file: ProjectFile, tracks: UiTrack[]): ResolveResult {
  const missing: MissingLane[] = [];
  const lanes: Lane[] = [];
  for (const saved of file.composition.lanes) {
    const track = resolveTrack(saved.track, tracks);
    if (!track) {
      missing.push({ lane: saved, reason: "not in this library" });
      continue;
    }
    if (!track.file_path) {
      missing.push({ lane: saved, reason: "has no audio file" });
      continue;
    }
    const { track: _snapshot, ...rest } = saved;
    lanes.push({ ...rest, track, seeded: true });
  }
  const laneIds = new Set(lanes.map((l) => l.id));
  const clips = file.composition.clips.filter((c) => laneIds.has(c.laneId));
  return {
    comp: {
      masterBpm: file.composition.masterBpm,
      snap: file.composition.snap,
      lanes,
      clips,
    },
    missing,
  };
}

// ---- change detection ---------------------------------------------------

/**
 * A stable digest of everything a project file stores. Two compositions
 * with the same fingerprint would save to byte-identical arrangements, so
 * "dirty" is simply fingerprint(now) !== fingerprint(last save). Track
 * metadata (energy, genre…) is deliberately left out: it belongs to the
 * library, not the arrangement.
 */
export function compositionFingerprint(comp: Composition): string {
  return JSON.stringify({
    b: comp.masterBpm,
    s: comp.snap,
    l: comp.lanes.map((l) => [
      l.id,
      l.track.track_id,
      l.gain,
      l.eqLow,
      l.eqMid,
      l.eqHigh,
      l.hp,
      l.lp,
      l.sync,
      l.mute,
      l.solo,
    ]),
    c: comp.clips.map((c) => [
      c.id,
      c.laneId,
      c.start,
      c.offset,
      c.length,
      c.fadeIn,
      c.fadeOut,
      c.fadeInAuto ?? null,
      c.fadeOutAuto ?? null,
    ]),
  });
}

// ---- names and paths ----------------------------------------------------

/** `/a/b/My Mix.t2m` → `My Mix`. */
export function projectNameFromPath(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  const stripped = base.replace(new RegExp(`\\.${PROJECT_EXT}$`, "i"), "");
  return stripped.trim() || UNTITLED;
}

/** Make sure a picked path ends in `.t2m` (GTK dialogs don't add it). */
export function withProjectExt(path: string): string {
  return new RegExp(`\\.${PROJECT_EXT}$`, "i").test(path) ? path : `${path}.${PROJECT_EXT}`;
}

/** A filesystem-safe stem for exports: `My Mix / v2` → `My-Mix-v2`. */
export function fileStem(name: string): string {
  const s = name
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-");
  return s || "track2mix";
}
