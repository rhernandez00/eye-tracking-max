import { Marker } from "./types";

/** Key for the one-marker-per-frame map. */
export function markerKey(stimId: string, frameIndex: number): string {
  return `${stimId}#${frameIndex}`;
}

export class MarkerStore {
  private map = new Map<string, Marker>();
  dirty = false;

  get(stimId: string, frameIndex: number): Marker | undefined {
    return this.map.get(markerKey(stimId, frameIndex));
  }

  put(m: Marker): void {
    this.map.set(markerKey(m.stimId, m.frameIndex), m);
    this.dirty = true;
  }

  delete(stimId: string, frameIndex: number): boolean {
    const ok = this.map.delete(markerKey(stimId, frameIndex));
    if (ok) this.dirty = true;
    return ok;
  }

  /** All markers, ordered by stim id then frame index. */
  all(): Marker[] {
    return [...this.map.values()].sort(
      (a, b) => (a.stimId < b.stimId ? -1 : a.stimId > b.stimId ? 1 : a.frameIndex - b.frameIndex)
    );
  }

  get size(): number {
    return this.map.size;
  }

  load(markers: Marker[]): void {
    this.map.clear();
    for (const m of markers) this.map.set(markerKey(m.stimId, m.frameIndex), m);
    this.dirty = false;
  }
}

const CSV_HEADER = [
  "stim_id",
  "frame_index",
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
        m.stimId,
        m.frameIndex,
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
      stimId: c[h["stim_id"]],
      frameIndex: +c[h["frame_index"]],
      frameTime: +c[h["frame_time"]],
      fps: +c[h["fps"]],
      delayMs: +c[h["delay_ms"]],
      isAnchor: c[h["is_anchor"]] === "1" || c[h["is_anchor"]]?.toLowerCase() === "true",
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
