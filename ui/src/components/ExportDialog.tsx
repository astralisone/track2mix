import * as React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { save } from "@tauri-apps/plugin-dialog";
import { Button } from "./ui/Button";
import { Input } from "./ui/Input";
import { exportPlaylist, type ExportFormat } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { Download, FolderOpen } from "lucide-react";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedIds: string[];
  defaultName?: string;
};

const FORMATS: Record<
  ExportFormat,
  { label: string; ext: string; exts: string[]; filter: string; hint: string }
> = {
  m3u8: {
    label: "Rekordbox",
    ext: "m3u8",
    exts: ["m3u8", "m3u"],
    filter: "M3U8 playlist",
    hint: "Save as M3U8, then in Rekordbox: File → Import Playlist.",
  },
  traktor: {
    label: "Traktor",
    ext: "nml",
    exts: ["nml"],
    filter: "Traktor collection (NML)",
    hint: "Writes a small Traktor collection with one playlist. Bring it in with Import Another Collection.",
  },
  serato: {
    label: "Serato",
    ext: "crate",
    exts: ["crate"],
    filter: "Serato crate",
    hint: "Save into your _Serato_/Subcrates folder (usually ~/Music/_Serato_/Subcrates), then restart Serato.",
  },
};

function loadFormat(): ExportFormat {
  try {
    const v = localStorage.getItem("track2mix.exportFormat");
    if (v === "m3u8" || v === "traktor" || v === "serato") return v;
  } catch {
    /* storage unavailable */
  }
  return "m3u8";
}

function swapExt(path: string, ext: string): string {
  return path.replace(/\.[A-Za-z0-9]+$/, "") + "." + ext;
}

export function ExportDialog({ open, onOpenChange, selectedIds, defaultName }: Props) {
  const [name, setName] = React.useState(defaultName ?? "Track2Mix set");
  const [format, setFormat] = React.useState<ExportFormat>(loadFormat);
  const [path, setPath] = React.useState("");
  const [traktorVolume, setTraktorVolume] = React.useState("");
  const [seratoRoot, setSeratoRoot] = React.useState("");
  const [mapFrom, setMapFrom] = React.useState("");
  const [mapTo, setMapTo] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [ok, setOk] = React.useState<string | null>(null);

  const spec = FORMATS[format];

  React.useEffect(() => {
    if (open) {
      setName(defaultName ?? "Track2Mix set");
      setErr(null);
      setOk(null);
    }
  }, [open, defaultName]);

  function chooseFormat(f: ExportFormat) {
    setFormat(f);
    setOk(null);
    setErr(null);
    if (path) setPath(swapExt(path, FORMATS[f].ext));
    try {
      localStorage.setItem("track2mix.exportFormat", f);
    } catch {
      /* storage unavailable */
    }
  }

  async function pickPath() {
    try {
      const picked = await save({
        defaultPath:
          path || `${name.replace(/[^a-z0-9\-_ ]/gi, "")}.${spec.ext}`,
        filters: [{ name: spec.filter, extensions: spec.exts }],
      });
      if (picked) setPath(picked);
    } catch (e) {
      setErr(String(e));
    }
  }

  async function doExport() {
    if (!path) {
      setErr("Pick a destination file first.");
      return;
    }
    setBusy(true);
    setErr(null);
    setOk(null);
    try {
      const report = await exportPlaylist({
        path,
        playlist_name: name,
        track_ids: selectedIds,
        format,
        traktor_volume: format === "traktor" ? traktorVolume.trim() || undefined : undefined,
        serato_root: format === "serato" ? seratoRoot.trim() || undefined : undefined,
        path_map:
          mapFrom.trim() && mapTo.trim()
            ? [[mapFrom.trim(), mapTo.trim()]]
            : undefined,
      });
      const left =
        report.skipped > 0
          ? ` (${report.skipped} left out: no file path${
              format === "serato" && seratoRoot.trim() ? ", or outside the drive root" : ""
            })`
          : "";
      setOk(`Wrote ${report.written} track(s) to ${path}${left}`);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-bg-deep/70 backdrop-blur-sm animate-fade-in" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] max-h-[90vh] overflow-auto glass rounded-xl p-5 animate-fade-in">
          <Dialog.Title className="text-sm font-semibold text-white mb-1">
            Export playlist
          </Dialog.Title>
          <Dialog.Description className="text-xs text-muted-foreground mb-4">
            {selectedIds.length} track{selectedIds.length === 1 ? "" : "s"} selected.{" "}
            {spec.hint}
          </Dialog.Description>

          <div className="space-y-3">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Format</label>
              <div className="grid grid-cols-3 gap-1 p-1 rounded-md bg-white/[0.03] border border-white/10">
                {(Object.keys(FORMATS) as ExportFormat[]).map((f) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => chooseFormat(f)}
                    className={cn(
                      "h-8 rounded text-xs transition-all",
                      f === format
                        ? "bg-iris-500/90 text-white"
                        : "text-muted-foreground hover:text-foreground hover:bg-white/[0.06]",
                    )}
                  >
                    {FORMATS[f].label}
                    <span className="opacity-60"> .{FORMATS[f].ext}</span>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="text-xs text-muted-foreground mb-1 block">
                Playlist name
              </label>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </div>

            <div>
              <label className="text-xs text-muted-foreground mb-1 block">
                Destination
              </label>
              <div className="flex gap-2">
                <Input
                  value={path}
                  readOnly
                  placeholder="Pick a file…"
                  className="flex-1 text-xs"
                />
                <Button variant="outline" size="md" onClick={pickPath}>
                  <FolderOpen className="h-3.5 w-3.5" />
                  Browse
                </Button>
              </div>
            </div>

            {format === "traktor" && (
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">
                  Traktor volume <span className="opacity-60">(optional)</span>
                </label>
                <Input
                  value={traktorVolume}
                  onChange={(e) => setTraktorVolume(e.target.value)}
                  placeholder='Macintosh HD — or "C:" when exporting for a Windows machine'
                  className="text-xs"
                />
              </div>
            )}

            {format === "serato" && (
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">
                  Drive root <span className="opacity-60">(optional)</span>
                </label>
                <Input
                  value={seratoRoot}
                  onChange={(e) => setSeratoRoot(e.target.value)}
                  placeholder="Home drive by default — e.g. /Volumes/SSD for an external drive"
                  className="text-xs"
                />
              </div>
            )}

            {format !== "m3u8" && (
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer select-none hover:text-foreground">
                  Files live somewhere else on the DJ machine?
                </summary>
                <div className="flex gap-2 mt-2">
                  <Input
                    value={mapFrom}
                    onChange={(e) => setMapFrom(e.target.value)}
                    placeholder="Replace this prefix…"
                    className="text-xs"
                  />
                  <Input
                    value={mapTo}
                    onChange={(e) => setMapTo(e.target.value)}
                    placeholder="…with this"
                    className="text-xs"
                  />
                </div>
              </details>
            )}

            {err && (
              <div className="text-xs text-red-300 bg-red-500/10 border border-red-400/20 rounded-md p-2">
                {err}
              </div>
            )}
            {ok && (
              <div className="text-xs text-iris-200 bg-iris-500/10 border border-iris-500/25 rounded-md p-2">
                {ok}
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2 mt-5">
            <Dialog.Close asChild>
              <Button variant="ghost">Close</Button>
            </Dialog.Close>
            <Button variant="primary" onClick={doExport} disabled={busy}>
              <Download className="h-3.5 w-3.5" />
              {busy ? "Exporting…" : "Export"}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
