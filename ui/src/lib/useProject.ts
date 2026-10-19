import * as React from "react";
import { ask, open as openFile, save as saveFile } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { readProject, writeProject, type UiTrack } from "@/lib/tauri";
import { emptyComposition, type Composition, type Lane } from "@/audio/model";
import {
  compositionFingerprint,
  fileStem,
  parseProject,
  projectNameFromPath,
  PROJECT_EXT,
  resolveProject,
  serializeProject,
  UNTITLED,
  withProjectExt,
  type MissingLane,
} from "@/audio/project";

export type ProjectInfo = {
  /** Where the project was last read from or written to; null until saved. */
  path: string | null;
  name: string;
  /** True when the arrangement differs from what is on disk (or was never saved). */
  dirty: boolean;
};

export type ProjectNotice = { kind: "ok" | "err"; text: string; seq: number };

export type ProjectApi = {
  project: ProjectInfo;
  notice: ProjectNotice | null;
  newProject: () => Promise<void>;
  openProject: () => Promise<void>;
  saveProject: () => Promise<boolean>;
  saveProjectAs: () => Promise<boolean>;
  /**
   * Ask before throwing the arrangement away. Resolves true when there is
   * nothing to lose or the user chose to discard; false to keep editing.
   */
  confirmDiscard: (what: string) => Promise<boolean>;
  /** Forget the file association after a library switch (ids no longer match). */
  reset: () => void;
};

type Args = {
  comp: Composition;
  tracks: UiTrack[];
  /** DB path, recorded in the file so a later open can explain a mismatch. */
  library: string | null;
  /** Replace the arrangement (the caller also stops the engine and switches view). */
  replace: (next: Composition) => void;
};

const FILTERS = [{ name: "Track2Mix composition", extensions: [PROJECT_EXT] }];

/**
 * The project file state around a composition: which `.t2m` it belongs
 * to, whether it has unsaved changes, and the open/save flows. Dirty is
 * derived, not tracked: the fingerprint of the current arrangement against
 * the fingerprint of what was last read or written.
 */
export function useProject({ comp, tracks, library, replace }: Args): ProjectApi {
  const [path, setPath] = React.useState<string | null>(null);
  const [name, setName] = React.useState(UNTITLED);
  const [savedFp, setSavedFp] = React.useState(() => compositionFingerprint(emptyComposition()));
  const [notice, setNotice] = React.useState<ProjectNotice | null>(null);
  const seq = React.useRef(0);

  const dirty = React.useMemo(() => compositionFingerprint(comp) !== savedFp, [comp, savedFp]);

  // Async flows read the latest values, not the ones from the render they started in.
  const latest = React.useRef({ comp, tracks, library, path, name, dirty });
  latest.current = { comp, tracks, library, path, name, dirty };

  const say = React.useCallback((kind: "ok" | "err", text: string) => {
    seq.current += 1;
    setNotice({ kind, text, seq: seq.current });
  }, []);

  // Window title mirrors the document state, like any editor.
  React.useEffect(() => {
    const title = `${dirty ? "● " : ""}${name} — Track2Mix`;
    try {
      getCurrentWindow()
        .setTitle(title)
        .catch(() => {});
    } catch {
      /* not running under Tauri (tests, plain browser) */
    }
  }, [name, dirty]);

  // Closing the window with unsaved changes asks first.
  React.useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    try {
      getCurrentWindow()
        .onCloseRequested(async (e) => {
          if (!latest.current.dirty) return;
          const ok = await ask(
            `"${latest.current.name}" has unsaved changes. Close without saving?`,
            { title: "Unsaved composition", kind: "warning", okLabel: "Close anyway", cancelLabel: "Keep editing" },
          );
          if (!ok) e.preventDefault();
        })
        .then((un) => {
          if (cancelled) un();
          else unlisten = un;
        })
        .catch(() => {});
    } catch {
      /* not under Tauri */
    }
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const confirmDiscard = React.useCallback(async (what: string): Promise<boolean> => {
    if (!latest.current.dirty) return true;
    return ask(`"${latest.current.name}" has unsaved changes. ${what} and lose them?`, {
      title: "Unsaved composition",
      kind: "warning",
      okLabel: "Discard changes",
      cancelLabel: "Keep editing",
    });
  }, []);

  const writeTo = React.useCallback(
    async (target: string): Promise<boolean> => {
      const { comp: cur, library: lib } = latest.current;
      const newName = projectNameFromPath(target);
      try {
        const text = serializeProject(cur, { name: newName, library: lib });
        const bytes = await writeProject(target, text);
        setPath(target);
        setName(newName);
        setSavedFp(compositionFingerprint(cur));
        say("ok", `Saved "${newName}" — ${(bytes / 1024).toFixed(1)} KB → ${target}`);
        return true;
      } catch (e) {
        say("err", `Save failed: ${String(e)}`);
        return false;
      }
    },
    [say],
  );

  const saveProjectAs = React.useCallback(async (): Promise<boolean> => {
    const { path: cur, name: curName } = latest.current;
    let picked: string | null;
    try {
      picked = await saveFile({
        defaultPath: cur ?? `${fileStem(curName)}.${PROJECT_EXT}`,
        filters: FILTERS,
      });
    } catch (e) {
      say("err", `Save dialog failed: ${String(e)}`);
      return false;
    }
    if (!picked) return false;
    return writeTo(withProjectExt(picked));
  }, [say, writeTo]);

  const saveProject = React.useCallback(async (): Promise<boolean> => {
    const { path: cur } = latest.current;
    return cur ? writeTo(cur) : saveProjectAs();
  }, [writeTo, saveProjectAs]);

  const newProject = React.useCallback(async () => {
    if (!(await confirmDiscard("Start a new composition"))) return;
    replace(emptyComposition());
    setPath(null);
    setName(UNTITLED);
    setSavedFp(compositionFingerprint(emptyComposition()));
  }, [confirmDiscard, replace]);

  const openProject = React.useCallback(async () => {
    if (!(await confirmDiscard("Open another composition"))) return;
    let picked: string | string[] | null;
    try {
      picked = await openFile({ multiple: false, directory: false, filters: FILTERS });
    } catch (e) {
      say("err", `Open dialog failed: ${String(e)}`);
      return;
    }
    if (typeof picked !== "string") return;
    try {
      const file = parseProject(await readProject(picked));
      const { comp: next, missing } = resolveProject(file, latest.current.tracks);
      const savedLanes = file.composition.lanes.length;
      if (savedLanes > 0 && next.lanes.length === 0) {
        const where = file.library ? ` (it was saved against ${file.library})` : "";
        say(
          "err",
          `Couldn't open "${file.name}": none of its ${savedLanes} track${savedLanes === 1 ? "" : "s"} are in this library${where}.`,
        );
        return;
      }
      replace(next);
      setPath(picked);
      setName(file.name);
      // Fingerprint what is on disk, not what was resolved: if lanes were
      // dropped the project is immediately dirty, and saving will rewrite it.
      setSavedFp(
        compositionFingerprint({
          ...file.composition,
          lanes: file.composition.lanes as Lane[],
        }),
      );
      if (missing.length > 0) {
        say("err", `Opened "${file.name}" with ${missing.length} lane${missing.length === 1 ? "" : "s"} skipped: ${describeMissing(missing)}. Saving will drop them for good.`);
      } else {
        say("ok", `Opened "${file.name}" — ${next.lanes.length} lane${next.lanes.length === 1 ? "" : "s"}, ${next.clips.length} clip${next.clips.length === 1 ? "" : "s"}`);
      }
    } catch (e) {
      say("err", `Couldn't open ${picked}: ${String(e)}`);
    }
  }, [confirmDiscard, replace, say]);

  const reset = React.useCallback(() => {
    setPath(null);
    setName(UNTITLED);
    setSavedFp(compositionFingerprint(emptyComposition()));
  }, []);

  return {
    project: { path, name, dirty },
    notice,
    newProject,
    openProject,
    saveProject,
    saveProjectAs,
    confirmDiscard,
    reset,
  };
}

function describeMissing(missing: MissingLane[]): string {
  const parts = missing.slice(0, 3).map((m) => {
    const t = m.lane.track;
    const label = t.artist ? `${t.artist} – ${t.name}` : t.name || t.track_id;
    return `${label} (${m.reason})`;
  });
  if (missing.length > 3) parts.push(`and ${missing.length - 3} more`);
  return parts.join("; ");
}
