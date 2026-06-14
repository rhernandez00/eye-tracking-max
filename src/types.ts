// ---- Core domain types ----

/** One row of *_full_log.csv, as a slice of the continuous acquisition timeline. */
export interface TimelineEvent {
  index: number; // order within the session
  type: string; // "stim" | "attractor" | "baseline" | …
  id: string; // stim folder name, attractor id ("0".."8"), or baseline id
  onset: number; // seconds, same clock as raw eyetrack
  end: number; // onset of the next event (or acquisition end)
}

/** Parsed raw eyetrack samples, columnar for fast lookup. */
export interface RawEyetrack {
  t: Float64Array; // timestamp (s), ascending
  x: Float32Array; // pos_x (tracker space)
  y: Float32Array; // pos_y (tracker space)
  n: number;
}

/** One marker == one labelled point on the global timeline (one per global frame). */
export interface Marker {
  globalFrame: number; // floor(displayTime * fps); unique key along the timeline
  frameTime: number; // display time in seconds (= globalFrame / fps)
  fps: number;
  delayMs: number;
  isAnchor: boolean;
  auto: boolean; // true = automatically pre-selected; the manual fits ignore these
  eventType: string; // what was on screen: stim | attractor | baseline
  eventId: string; // stim folder / attractor id / baseline id
  stimFrameIndex: number; // local frame within a stim clip, -1 for attractor/baseline
  rawPosX: number; // matched raw sample (tracker space)
  rawPosY: number;
  rawTimestamp: number;
  trueX: number; // centered image coords, range ±COORD_RANGE
  trueY: number;
  createdAt: string; // ISO
  note: string;
}

/** Visual-only affine mapping raw tracker coords -> image pixels (0..IMAGE_SIZE). */
export interface PreviewTransform {
  sx: number;
  sy: number;
  ox: number;
  oy: number;
  flipY: boolean;
}

export const IMAGE_SIZE = 1080; // px (frames are 1080x1080)
export const COORD_RANGE = 900; // saved coords span -900..+900, origin = image center
export const ATTRACTOR_EXTENT = 400; // attractor offset from centre, in screen px (EmoC 3x3 grid)

// ---- Calibration ----

/** FSL/MCFLIRT motion parameters, one row per fMRI volume. */
export interface MotionData {
  n: number; // number of volumes
  m: Float64Array[]; // 6 motion params, each length n
  fd: Uint8Array | null; // optional framewise-displacement flag (1 = flagged), length n
}

export type CalibKind = "affine" | "poly2" | "mocet" | "mocet_censored";

/** Which anchor set a fit was trained on: the automatic baseline or the user's manual picks. */
export type CalibSource = "auto" | "manual";

/**
 * A fitted gaze-calibration model. Pure data (no closures) so it can be cloned
 * into IndexedDB. Evaluate with predictGaze() in calibrate.ts.
 *
 * Gaze map: trueX = gx·feat, trueY = gy·feat, where feat depends on `kind`.
 * For MoCET, the raw signal is first de-drifted with driftX/driftY over the
 * design [1, time-poly…, m1..m6] before the affine gaze map is applied.
 */
export interface CalibrationModel {
  kind: CalibKind;
  gx: number[]; // gaze-map coeffs for X
  gy: number[]; // gaze-map coeffs for Y
  driftX: number[]; // MoCET stage-1 drift coeffs for raw X (empty otherwise)
  driftY: number[];
  polyOrder: number; // MoCET time-polynomial order (0 for affine/poly2)
  censor: boolean; // MoCET: FD-flagged volumes excluded from the drift fit
  tr: number; // repetition time (s) used for the fit
  tScale: number; // time normalisation used in the design (s)
  nAnchors: number; // anchors used for the fit
  rmseTrain: number; // 2-D RMSE on the training anchors (coord units)
  rmseVal: number | null; // 2-D RMSE on non-anchor markers, if any
  createdAt: string; // ISO
  stale: boolean; // anchors/motion/TR changed since the fit
}

export const CALIB_KINDS: CalibKind[] = ["affine", "poly2", "mocet", "mocet_censored"];

export const CALIB_META: Record<
  CalibKind,
  { label: string; color: string; minAnchors: number; needsMotion: boolean }
> = {
  affine: { label: "Affine", color: "#4aa3ff", minAnchors: 3, needsMotion: false },
  poly2: { label: "Poly-2", color: "#c08bff", minAnchors: 6, needsMotion: false },
  mocet: { label: "MoCET", color: "#ffb454", minAnchors: 3, needsMotion: true },
  mocet_censored: { label: "MoCET (FD-censored)", color: "#38e08b", minAnchors: 3, needsMotion: true },
};

export const MOCET_POLY_ORDER = 3; // cubic time regressors (Park et al.)
