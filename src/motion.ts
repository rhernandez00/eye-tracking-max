import { MotionData } from "./types";

/**
 * Parse an FSL/MCFLIRT motion file (`*_fwd.txt`): whitespace-separated, no header.
 * Columns 1-6 are the 6 motion parameters; an optional 7th column is the binary
 * framewise-displacement (FD) flag. One row per fMRI volume.
 */
export function parseMotion(text: string): MotionData {
  const rows: number[][] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(/\s+/).map(Number);
    if (parts.length < 6) continue;
    let ok = true;
    for (let i = 0; i < 6; i++) if (!isFinite(parts[i])) ok = false;
    if (ok) rows.push(parts);
  }

  const n = rows.length;
  const m = Array.from({ length: 6 }, () => new Float64Array(n));
  const hasFd = n > 0 && rows.every((r) => r.length >= 7);
  const fd = hasFd ? new Uint8Array(n) : null;

  for (let k = 0; k < n; k++) {
    for (let c = 0; c < 6; c++) m[c][k] = rows[k][c];
    if (fd) fd[k] = rows[k][6] >= 0.5 ? 1 : 0;
  }
  return { n, m, fd };
}

/** Linearly-interpolated 6 motion params at time `t` (s). Volume k is at k·TR. */
export function motionAt(md: MotionData, t: number, tr: number): number[] {
  const out = new Array(6).fill(0);
  if (md.n === 0) return out;
  const f = tr > 0 ? t / tr : 0;
  if (f <= 0) {
    for (let c = 0; c < 6; c++) out[c] = md.m[c][0];
    return out;
  }
  if (f >= md.n - 1) {
    for (let c = 0; c < 6; c++) out[c] = md.m[c][md.n - 1];
    return out;
  }
  const k = Math.floor(f);
  const frac = f - k;
  for (let c = 0; c < 6; c++) out[c] = md.m[c][k] * (1 - frac) + md.m[c][k + 1] * frac;
  return out;
}

/** Whether the volume covering time `t` is FD-flagged (false if no FD column). */
export function volumeFlagged(md: MotionData, t: number, tr: number): boolean {
  if (!md.fd || md.n === 0) return false;
  let k = tr > 0 ? Math.round(t / tr) : 0;
  if (k < 0) k = 0;
  if (k > md.n - 1) k = md.n - 1;
  return md.fd[k] === 1;
}

/** Count of FD-flagged volumes (0 if no FD column). */
export function fdCount(md: MotionData): number {
  if (!md.fd) return 0;
  let s = 0;
  for (let k = 0; k < md.n; k++) s += md.fd[k];
  return s;
}
