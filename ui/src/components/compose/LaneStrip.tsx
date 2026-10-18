import * as React from "react";
import { cn, formatBpm } from "@/lib/utils";
import { KeyChip } from "../KeyChip";
import { Button } from "../ui/Button";
import { Knob, fmtDb, fmtGain, fmtHz } from "./Knob";
import {
  EQ_KILL,
  HP_MIN,
  LP_MAX,
  laneRate,
  type Lane,
} from "@/audio/model";
import { keyRelation, RELATION_LABEL, RELATION_TONE } from "@/audio/camelot";
import { Headphones, Link2, Link2Off, Plus, Trash2, VolumeX } from "lucide-react";

export const LANE_HEIGHT = 108;

type Props = {
  lane: Lane;
  referenceKey: string | null;
  masterBpm: number;
  loaded: boolean;
  onChange: (patch: Partial<Lane>) => void;
  onAddClip: () => void;
  onRemove: () => void;
};

/** Mixer-strip header for one lane; sits to the left of its timeline row. */
export function LaneStrip({
  lane,
  referenceKey,
  masterBpm,
  loaded,
  onChange,
  onAddClip,
  onRemove,
}: Props) {
  const rel = keyRelation(referenceKey, lane.track.camelot);
  const tone = RELATION_TONE[rel];
  const rate = laneRate(lane, masterBpm);
  const ratePct = (rate - 1) * 100;

  return (
    <div
      className={cn(
        "flex flex-col gap-1 px-2.5 py-1.5 border-b border-white/[0.06] border-l-2",
        tone.border.replace("border-", "border-l-"),
        lane.mute && "opacity-60",
      )}
      style={{ height: LANE_HEIGHT }}
    >
      <div className="flex items-center gap-1.5 min-w-0">
        <KeyChip camelot={lane.track.camelot} raw={lane.track.tonality} />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium truncate" title={lane.track.name}>
            {lane.track.name}
          </div>
          <div className="text-[10px] text-muted-foreground truncate flex items-center gap-1">
            <span className="truncate">{lane.track.artist}</span>
            <span className="text-muted-foreground/40">·</span>
            <span className="tabular-nums">{formatBpm(lane.track.bpm)}</span>
            {lane.sync && Math.abs(ratePct) > 0.05 && (
              <span className="tabular-nums text-iris-200/80">
                {ratePct > 0 ? "+" : ""}
                {ratePct.toFixed(1)}%
              </span>
            )}
          </div>
        </div>
        <span
          className={cn("text-[9px] uppercase tracking-wider px-1 rounded", tone.text, tone.bg)}
          title={`Key relation to the first lane: ${RELATION_LABEL[rel]}`}
        >
          {RELATION_LABEL[rel]}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
        <Knob
          label="Vol"
          value={lane.gain}
          min={0}
          max={1.5}
          step={0.01}
          reset={1}
          format={fmtGain}
          onChange={(gain) => onChange({ gain })}
        />
        <Knob
          label="Lo"
          value={lane.eqLow}
          min={EQ_KILL}
          max={12}
          step={0.5}
          reset={0}
          format={fmtDb}
          accent={lane.eqLow <= EQ_KILL ? "red" : "iris"}
          onChange={(eqLow) => onChange({ eqLow })}
        />
        <Knob
          label="HP"
          value={lane.hp}
          min={HP_MIN}
          max={4000}
          step={5}
          reset={HP_MIN}
          format={fmtHz}
          accent="gold"
          onChange={(hp) => onChange({ hp })}
        />
        <Knob
          label="Mid"
          value={lane.eqMid}
          min={EQ_KILL}
          max={12}
          step={0.5}
          reset={0}
          format={fmtDb}
          accent={lane.eqMid <= EQ_KILL ? "red" : "iris"}
          onChange={(eqMid) => onChange({ eqMid })}
        />
        <Knob
          label="LP"
          value={lane.lp}
          min={300}
          max={LP_MAX}
          step={50}
          reset={LP_MAX}
          format={fmtHz}
          accent="gold"
          onChange={(lp) => onChange({ lp })}
        />
        <Knob
          label="Hi"
          value={lane.eqHigh}
          min={EQ_KILL}
          max={12}
          step={0.5}
          reset={0}
          format={fmtDb}
          accent={lane.eqHigh <= EQ_KILL ? "red" : "iris"}
          onChange={(eqHigh) => onChange({ eqHigh })}
        />
      </div>

      <div className="flex items-center gap-1 mt-auto">
        <ToggleBtn
          on={lane.sync}
          title={lane.sync ? "Synced to master BPM (click to free-run)" : "Free-running (click to sync)"}
          onClick={() => onChange({ sync: !lane.sync })}
          disabled={!lane.track.bpm}
        >
          {lane.sync ? <Link2 className="h-3 w-3" /> : <Link2Off className="h-3 w-3" />}
          Sync
        </ToggleBtn>
        <ToggleBtn
          on={lane.mute}
          tone="red"
          title="Mute"
          onClick={() => onChange({ mute: !lane.mute })}
        >
          <VolumeX className="h-3 w-3" />M
        </ToggleBtn>
        <ToggleBtn
          on={lane.solo}
          tone="gold"
          title="Solo"
          onClick={() => onChange({ solo: !lane.solo })}
        >
          <Headphones className="h-3 w-3" />S
        </ToggleBtn>
        <span className="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-1.5 text-[10px]"
          title={loaded ? "Place a clip of this track at the playhead" : "Decoding audio…"}
          onClick={onAddClip}
          disabled={!loaded}
        >
          <Plus className="h-3 w-3" />
          Clip
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 px-0 text-muted-foreground hover:text-red-200"
          title="Remove lane"
          onClick={onRemove}
        >
          <Trash2 className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
}

function ToggleBtn({
  on,
  tone = "iris",
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  on: boolean;
  tone?: "iris" | "red" | "gold";
}) {
  const onCls =
    tone === "red"
      ? "bg-red-500/25 text-red-100 border-red-400/40"
      : tone === "gold"
        ? "bg-gold-300/25 text-gold-100 border-gold-300/40"
        : "bg-iris-500/25 text-iris-100 border-iris-400/40";
  return (
    <button
      type="button"
      className={cn(
        "inline-flex items-center gap-0.5 h-6 px-1.5 rounded text-[10px] font-medium border transition-colors disabled:opacity-40",
        on ? onCls : "border-white/10 text-muted-foreground hover:text-foreground hover:bg-white/[0.05]",
        className,
      )}
      {...props}
    />
  );
}
