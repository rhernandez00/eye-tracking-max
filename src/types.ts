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
