import { RawEyetrack, StimSegment } from "./types";

/** Split a CSV header line into column-index map. */
function headerIndex(line: string): Record<string, number> {
  const idx: Record<string, number> = {};
  line.split(",").forEach((c, i) => (idx[c.trim()] = i));
  return idx;
}

/**
 * Parse *_raw_eyetrack.csv into columnar typed arrays.
 * Only pos_x, pos_y, timestamp are kept (the columns this tool needs).
 * Handcoded for speed over ~300k rows.
 */
export function parseRawEyetrack(text: string): RawEyetrack {
  const nl = text.indexOf("\n");
  const header = headerIndex(text.slice(0, nl));
  const ix = header["pos_x"] ?? 0;
  const iy = header["pos_y"] ?? 1;
  const it = header["timestamp"] ?? 3;
  const maxCol = Math.max(ix, iy, it);

  const body = text.slice(nl + 1);
  // Pre-count rows to size arrays (count newlines).
  let rows = 0;
  for (let i = 0; i < body.length; i++) if (body.charCodeAt(i) === 10) rows++;
  rows += 1; // last line may lack a trailing newline

  const t = new Float64Array(rows);
  const x = new Float32Array(rows);
  const y = new Float32Array(rows);

  let n = 0;
  let start = 0;
  const len = body.length;
  for (let i = 0; i <= len; i++) {
    if (i === len || body.charCodeAt(i) === 10) {
      if (i > start) {
        const line = body.slice(start, body.charCodeAt(i - 1) === 13 ? i - 1 : i);
        if (line.length) {
          // split just enough columns
          let col = 0;
          let s = 0;
          let vx = NaN, vy = NaN, vt = NaN;
          for (let j = 0; j <= line.length; j++) {
            if (j === line.length || line.charCodeAt(j) === 44) {
              if (col === ix) vx = +line.slice(s, j);
              else if (col === iy) vy = +line.slice(s, j);
              else if (col === it) vt = +line.slice(s, j);
              s = j + 1;
              col++;
              if (col > maxCol) break;
            }
          }
          if (vt === vt) {
            t[n] = vt;
            x[n] = vx;
            y[n] = vy;
            n++;
          }
        }
      }
      start = i + 1;
    }
  }
  return { t, x, y, n };
}

/** Index of the sample whose timestamp is nearest to `target`. Binary search. */
export function nearestSample(raw: RawEyetrack, target: number): number {
  const t = raw.t;
  let lo = 0;
  let hi = raw.n - 1;
  if (hi < 0) return -1;
  if (target <= t[0]) return 0;
  if (target >= t[hi]) return hi;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (t[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  // lo is first >= target; compare with lo-1
  if (lo > 0 && Math.abs(t[lo - 1] - target) <= Math.abs(t[lo] - target)) return lo - 1;
  return lo;
}

/**
 * Parse *_full_log.csv (type,onset,id) into ordered stim segments.
 * endTime = onset of the next log event (any type), else +Infinity.
 */
export function parseStimSegments(text: string): StimSegment[] {
  const lines = text.split(/\r?\n/).filter((l) => l.length);
  const header = headerIndex(lines[0]);
  const it = header["type"] ?? 0;
  const io = header["onset"] ?? 1;
  const id = header["id"] ?? 2;

  const events: { type: string; onset: number; id: string }[] = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(",");
    events.push({ type: c[it]?.trim(), onset: +c[io], id: c[id]?.trim() });
  }
  events.sort((a, b) => a.onset - b.onset);

  const segs: StimSegment[] = [];
  for (let i = 0; i < events.length; i++) {
    if (events[i].type !== "stim") continue;
    const next = events[i + 1];
    segs.push({
      index: segs.length,
      id: events[i].id,
      onset: events[i].onset,
      endTime: next ? next.onset : Number.POSITIVE_INFINITY,
      frameCount: -1,
    });
  }
  return segs;
}
