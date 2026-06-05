import { CalibrationModel, CALIB_META, Marker, MotionData, RawEyetrack } from "./types";
import { motionAt, volumeFlagged } from "./motion";

// ---- small dense linear algebra (problems are tiny: k <= ~10) ----

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** Solve A x = b in place (Gaussian elimination, partial pivoting). */
function gauss(A: number[][], b: number[]): number[] {
  const k = b.length;
  const M = A.map((r) => r.slice());
  const v = b.slice();
  for (let col = 0; col < k; col++) {
    let p = col;
    let mx = Math.abs(M[col][col]);
    for (let r = col + 1; r < k; r++) {
      const a = Math.abs(M[r][col]);
      if (a > mx) {
        mx = a;
        p = r;
      }
    }
    if (p !== col) {
      [M[p], M[col]] = [M[col], M[p]];
      [v[p], v[col]] = [v[col], v[p]];
    }
    const piv = M[col][col] || 1e-12;
    for (let r = col + 1; r < k; r++) {
      const fac = M[r][col] / piv;
      if (!fac) continue;
      for (let c = col; c < k; c++) M[r][c] -= fac * M[col][c];
      v[r] -= fac * v[col];
    }
  }
  const out = new Array(k).fill(0);
  for (let i = k - 1; i >= 0; i--) {
    let s = v[i];
    for (let j = i + 1; j < k; j++) s -= M[i][j] * out[j];
    out[i] = s / (M[i][i] || 1e-12);
  }
  return out;
}

/**
 * Accumulates normal equations for two targets (x and y) that share one design.
 * Lets MoCET stream over ~300k raw samples without materialising the matrix.
 */
class NormalEq {
  private A: Float64Array[];
  private bx: Float64Array;
  private by: Float64Array;
  constructor(private k: number) {
    this.A = Array.from({ length: k }, () => new Float64Array(k));
    this.bx = new Float64Array(k);
    this.by = new Float64Array(k);
  }
  add(row: number[], yx: number, yy: number): void {
    const { A, bx, by, k } = this;
    for (let i = 0; i < k; i++) {
      const ri = row[i];
      bx[i] += ri * yx;
      by[i] += ri * yy;
      const Ai = A[i];
      for (let j = i; j < k; j++) Ai[j] += ri * row[j];
    }
  }
  solve(ridge = 1e-6): { x: number[]; y: number[] } {
    const { A, k } = this;
    const M: number[][] = Array.from({ length: k }, (_, i) => Array.from(A[i]));
    for (let i = 0; i < k; i++) {
      for (let j = 0; j < i; j++) M[i][j] = M[j][i]; // mirror upper -> lower
      M[i][i] += ridge;
    }
    return { x: gauss(M, Array.from(this.bx)), y: gauss(M, Array.from(this.by)) };
  }
}

// ---- feature builders ----

function affineFeat(rx: number, ry: number): number[] {
  return [1, rx, ry];
}
function poly2Feat(rx: number, ry: number): number[] {
  return [1, rx, ry, rx * rx, ry * ry, rx * ry];
}
/** MoCET drift design row: [1, u, u^2, … u^polyOrder, m1..m6], u = t / tScale. */
function mocetDesign(t: number, motion: number[], polyOrder: number, tScale: number): number[] {
  const u = tScale ? t / tScale : 0;
  const row: number[] = [1];
  let p = u;
  for (let o = 1; o <= polyOrder; o++) {
    row.push(p);
    p *= u;
  }
  for (let c = 0; c < 6; c++) row.push(motion[c]);
  return row;
}

// ---- evaluation ----

/** Predicted gaze (centered coord space) for a raw sample at time `t`. */
export function predictGaze(
  model: CalibrationModel,
  rawX: number,
  rawY: number,
  t: number,
  motion: MotionData | null
): { x: number; y: number } {
  let feat: number[];
  if (model.kind === "mocet" || model.kind === "mocet_censored") {
    const mo = motion ? motionAt(motion, t, model.tr) : [0, 0, 0, 0, 0, 0];
    const row = mocetDesign(t, mo, model.polyOrder, model.tScale);
    const cx = rawX - dot(model.driftX, row);
    const cy = rawY - dot(model.driftY, row);
    feat = affineFeat(cx, cy);
  } else if (model.kind === "poly2") {
    feat = poly2Feat(rawX, rawY);
  } else {
    feat = affineFeat(rawX, rawY);
  }
  return { x: dot(model.gx, feat), y: dot(model.gy, feat) };
}

/** 2-D RMSE (coord units) of a model's prediction against marker true positions. */
function rmse(model: CalibrationModel, markers: Marker[], motion: MotionData | null): number {
  let s = 0;
  let n = 0;
  for (const m of markers) {
    if (!isFinite(m.rawPosX) || !isFinite(m.rawPosY)) continue;
    const p = predictGaze(model, m.rawPosX, m.rawPosY, m.rawTimestamp, motion);
    const dx = p.x - m.trueX;
    const dy = p.y - m.trueY;
    s += dx * dx + dy * dy;
    n++;
  }
  return n ? Math.sqrt(s / n) : 0;
}

const usableAnchors = (markers: Marker[]) =>
  markers.filter((m) => isFinite(m.rawPosX) && isFinite(m.rawPosY));

export type FitResult = CalibrationModel | { error: string };

// ---- fitters ----

export function fitAffine(anchors: Marker[], valMarkers: Marker[]): FitResult {
  const used = usableAnchors(anchors);
  const min = CALIB_META.affine.minAnchors;
  if (used.length < min) return { error: `Affine needs ≥${min} anchors (have ${used.length})` };

  const ne = new NormalEq(3);
  for (const a of used) ne.add(affineFeat(a.rawPosX, a.rawPosY), a.trueX, a.trueY);
  const g = ne.solve();
  return finalize("affine", g.x, g.y, [], [], 0, false, 0, 1, used, valMarkers, null);
}

export function fitPoly2(anchors: Marker[], valMarkers: Marker[]): FitResult {
  const used = usableAnchors(anchors);
  const min = CALIB_META.poly2.minAnchors;
  if (used.length < min) return { error: `Poly-2 needs ≥${min} anchors (have ${used.length})` };

  const ne = new NormalEq(6);
  for (const a of used) ne.add(poly2Feat(a.rawPosX, a.rawPosY), a.trueX, a.trueY);
  const g = ne.solve();
  return finalize("poly2", g.x, g.y, [], [], 0, false, 0, 1, used, valMarkers, null);
}

export function fitMoCET(opts: {
  raw: RawEyetrack;
  motion: MotionData;
  tr: number;
  polyOrder: number;
  censor: boolean;
  anchors: Marker[];
  valMarkers: Marker[];
}): FitResult {
  const { raw, motion, tr, polyOrder, censor, anchors, valMarkers } = opts;
  if (motion.n === 0) return { error: "no motion data loaded" };
  const used = usableAnchors(anchors);
  const min = CALIB_META.mocet.minAnchors;
  const label = censor ? "MoCET (FD-censored)" : "MoCET";
  if (used.length < min) return { error: `${label} needs ≥${min} anchors (have ${used.length})` };

  const tScale = raw.n ? raw.t[raw.n - 1] || 1 : 1;

  // Stage 1 — fit raw ~ [time-poly + motion] across the run; the residual is the
  // motion/drift-corrected signal.
  const k = 1 + polyOrder + 6;
  const drift = new NormalEq(k);
  let usedSamples = 0;
  for (let i = 0; i < raw.n; i++) {
    const t = raw.t[i];
    if (censor && motion.fd && volumeFlagged(motion, t, tr)) continue;
    const mo = motionAt(motion, t, tr);
    drift.add(mocetDesign(t, mo, polyOrder, tScale), raw.x[i], raw.y[i]);
    usedSamples++;
  }
  if (usedSamples <= k) return { error: `${label}: too few raw samples after censoring` };
  const d = drift.solve();

  // Stage 2 — affine gaze map on the corrected anchor coordinates.
  const ne2 = new NormalEq(3);
  for (const a of used) {
    const mo = motionAt(motion, a.rawTimestamp, tr);
    const row = mocetDesign(a.rawTimestamp, mo, polyOrder, tScale);
    const cx = a.rawPosX - dot(d.x, row);
    const cy = a.rawPosY - dot(d.y, row);
    ne2.add(affineFeat(cx, cy), a.trueX, a.trueY);
  }
  const g = ne2.solve();

  return finalize(
    censor ? "mocet_censored" : "mocet",
    g.x,
    g.y,
    d.x,
    d.y,
    polyOrder,
    censor,
    tr,
    tScale,
    used,
    valMarkers,
    motion
  );
}

function finalize(
  kind: CalibrationModel["kind"],
  gx: number[],
  gy: number[],
  driftX: number[],
  driftY: number[],
  polyOrder: number,
  censor: boolean,
  tr: number,
  tScale: number,
  used: Marker[],
  valMarkers: Marker[],
  motion: MotionData | null
): CalibrationModel {
  const model: CalibrationModel = {
    kind,
    gx,
    gy,
    driftX,
    driftY,
    polyOrder,
    censor,
    tr,
    tScale,
    nAnchors: used.length,
    rmseTrain: 0,
    rmseVal: null,
    createdAt: new Date().toISOString(),
    stale: false,
  };
  model.rmseTrain = rmse(model, used, motion);
  const val = valMarkers.filter((m) => isFinite(m.rawPosX) && isFinite(m.rawPosY));
  model.rmseVal = val.length ? rmse(model, val, motion) : null;
  return model;
}
