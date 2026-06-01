// ---- Core domain types ----

/** A stimulus presentation parsed from *_full_log.csv (type === "stim"). */
export interface StimSegment {
  index: number; // order within the session
  id: string; // stimulus id == frame folder name, e.g. "R4DogF2"
  onset: number; // seconds, same clock as raw eyetrack
  endTime: number; // onset of next log event (or session end)
  frameCount: number; // frames available on disk (-1 until enumerated)
}

/** Parsed raw eyetrack samples, columnar for fast lookup. */
export interface RawEyetrack {
  t: Float64Array; // timestamp (s), ascending
  x: Float32Array; // pos_x (tracker space)
  y: Float32Array; // pos_y (tracker space)
  n: number;
}

/** One marker == one labelled frame. At most one per (stimId, frameIndex). */
export interface Marker {
  stimId: string;
  frameIndex: number;
  frameTime: number; // onset + frameIndex/fps + delay, at capture time
  fps: number;
  delayMs: number;
  isAnchor: boolean;
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
