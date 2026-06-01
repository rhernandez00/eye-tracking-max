import { IMAGE_SIZE, COORD_RANGE, PreviewTransform } from "./types";

// ===== Saved "true" coordinate space =====
// Origin is the CENTER of the image; the image spans -COORD_RANGE..+COORD_RANGE
// on each axis (so image edges == ±900). X increases to the right.
// Y increases DOWNWARD by default (screen convention); flip here if the
// experiment uses Y-up — this is the single place that decides it.
const Y_DOWN = true;

/** image pixel (0..IMAGE_SIZE) -> centered coord (±COORD_RANGE) */
export function pixelToCoord(px: number, py: number): { x: number; y: number } {
  const x = (px / IMAGE_SIZE) * (2 * COORD_RANGE) - COORD_RANGE;
  let y = (py / IMAGE_SIZE) * (2 * COORD_RANGE) - COORD_RANGE;
  if (!Y_DOWN) y = -y;
  return { x, y };
}

/** centered coord (±COORD_RANGE) -> image pixel (0..IMAGE_SIZE) */
export function coordToPixel(x: number, y: number): { px: number; py: number } {
  const px = ((x + COORD_RANGE) / (2 * COORD_RANGE)) * IMAGE_SIZE;
  const cy = Y_DOWN ? y : -y;
  const py = ((cy + COORD_RANGE) / (2 * COORD_RANGE)) * IMAGE_SIZE;
  return { px, py };
}

/** raw tracker coord -> image pixel via the visual-only preview transform */
export function rawToPixel(rawX: number, rawY: number, pt: PreviewTransform): { px: number; py: number } {
  const px = rawX * pt.sx + pt.ox;
  let py = rawY * pt.sy + pt.oy;
  if (pt.flipY) py = IMAGE_SIZE - py;
  return { px, py };
}

export function clampPixel(v: number): number {
  return Math.max(0, Math.min(IMAGE_SIZE, v));
}
