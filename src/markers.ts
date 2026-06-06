import { Marker } from "./types";

export class MarkerStore {
  private map = new Map<number, Marker>(); // keyed by globalFrame
  dirty = false;

  get(globalFrame: number): Marker | undefined {
    return this.map.get(globalFrame);
  }

  put(m: Marker): void {
    this.map.set(m.globalFrame, m);
    this.dirty = true;
  }

  delete(globalFrame: number): boolean {
    const ok = this.map.delete(globalFrame);
    if (ok) this.dirty = true;
    return ok;
  }

  /** All markers ordered along the timeline. */
  all(): Marker[] {
    return [...this.map.values()].sort((a, b) => a.globalFrame - b.globalFrame);
  }

  get size(): number {
    return this.map.size;
  }

  load(markers: Marker[]): void {
    this.map.clear();
    for (const m of markers) this.map.set(m.globalFrame, m);
    this.dirty = false;
  }
}

// One row per labelled global frame: the raw↔true calibration pair and its
// timing, plus what was on screen (event_type/event_id/stim_frame_index) for
// audit and navigation. The regression itself only needs the raw↔true pair.
const CSV_HEADER = [
  "global_frame",
  "frame_time",
  "fps",
  "delay_ms",
  "is_anchor",
  "raw_pos_x",
  "raw_pos_y",
  "raw_timestamp",
  "true_x",
  "true_y",
  "created_at",
  "note",
];

function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function markersToCsv(markers: Marker[]): string {
  const lines = [CSV_HEADER.join(",")];
  for (const m of markers) {
    lines.push(
      [
        m.globalFrame,
        m.frameTime.toFixed(4),
        m.fps,
        m.delayMs,
        m.isAnchor ? 1 : 0,
        m.rawPosX,
        m.rawPosY,
        m.rawTimestamp.toFixed(4),
        m.trueX.toFixed(2),
        m.trueY.toFixed(2),
        m.createdAt,
        csvCell(m.note ?? ""),
      ].join(",")
    );
  }
  return lines.join("\n") + "\n";
}

export function markersFromCsv(text: string): Marker[] {
  const lines = text.split(/\r?\n/).filter((l) => l.length);
  if (!lines.length) return [];
  const h: Record<string, number> = {};
  lines[0].split(",").forEach((c, i) => (h[c.trim()] = i));
  const out: Marker[] = [];
  for (let i = 1; i < lines.length; i++) {
    const c = splitCsvLine(lines[i]);
    out.push({
      globalFrame: +c[h["global_frame"]],
      frameTime: +c[h["frame_time"]],
      fps: +c[h["fps"]],
      delayMs: +c[h["delay_ms"]],
      isAnchor: c[h["is_anchor"]] === "1" || c[h["is_anchor"]]?.toLowerCase() === "true",
      eventType: h["event_type"] != null ? c[h["event_type"]] ?? "" : "",
      eventId: h["event_id"] != null ? c[h["event_id"]] ?? "" : "",
      stimFrameIndex: h["stim_frame_index"] != null ? +c[h["stim_frame_index"]] : -1,
      rawPosX: +c[h["raw_pos_x"]],
      rawPosY: +c[h["raw_pos_y"]],
      rawTimestamp: +c[h["raw_timestamp"]],
      trueX: +c[h["true_x"]],
      trueY: +c[h["true_y"]],
      createdAt: c[h["created_at"]] ?? "",
      note: h["note"] != null ? c[h["note"]] ?? "" : "",
    });
  }
  return out;
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else q = false;
      } else cur += ch;
    } else {
      if (ch === '"') q = true;
      else if (ch === ",") {
        out.push(cur);
        cur = "";
      } else cur += ch;
    }
  }
  out.push(cur);
  return out;
}
