import { coordToPixel, rawToPixel } from "./coords";
import { IMAGE_SIZE, Marker, PreviewTransform } from "./types";

/** Draws the current frame plus raw-eye marker and the frame's true marker. */
export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private bitmap: ImageBitmap | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    this.canvas.width = IMAGE_SIZE;
    this.canvas.height = IMAGE_SIZE;
    this.ctx = canvas.getContext("2d")!;
  }

  setFrame(bmp: ImageBitmap | null): void {
    this.bitmap = bmp;
  }

  /** Convert a client (mouse) point to image pixel coordinates (0..IMAGE_SIZE). */
  clientToImage(clientX: number, clientY: number): { px: number; py: number } {
    const r = this.canvas.getBoundingClientRect();
    const px = ((clientX - r.left) / r.width) * IMAGE_SIZE;
    const py = ((clientY - r.top) / r.height) * IMAGE_SIZE;
    return { px, py };
  }

  draw(opts: {
    rawX: number | null;
    rawY: number | null;
    pt: PreviewTransform;
    marker: Marker | null;
    overlays?: { x: number; y: number; color: string; label: string }[];
  }): void {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, IMAGE_SIZE, IMAGE_SIZE);
    if (this.bitmap) ctx.drawImage(this.bitmap, 0, 0, IMAGE_SIZE, IMAGE_SIZE);
    else {
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, IMAGE_SIZE, IMAGE_SIZE);
    }

    // center crosshair (origin)
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(IMAGE_SIZE / 2, 0);
    ctx.lineTo(IMAGE_SIZE / 2, IMAGE_SIZE);
    ctx.moveTo(0, IMAGE_SIZE / 2);
    ctx.lineTo(IMAGE_SIZE, IMAGE_SIZE / 2);
    ctx.stroke();

    // raw eye marker — the eye-tracker's reported position, shown on every
    // frame. Mapped through the preview transform; if it lands outside the
    // frame it's clamped to the nearest edge (with a ring) so it stays visible.
    if (opts.rawX != null && opts.rawY != null) {
      const { px, py } = rawToPixel(opts.rawX, opts.rawY, opts.pt);
      const cx = Math.max(0, Math.min(IMAGE_SIZE, px));
      const cy = Math.max(0, Math.min(IMAGE_SIZE, py));
      const offscreen = cx !== px || cy !== py;
      this.dot(cx, cy, 9, "#ff5d7a", offscreen ? "raw ›" : "raw");
      if (offscreen) {
        ctx.strokeStyle = "#ff5d7a";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(cx, cy, 14, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // predicted-gaze overlays, one per visible calibration model. Drawn in
    // centered coord space; clamped to the canvas (with a ring) when off-frame.
    if (opts.overlays) {
      for (const o of opts.overlays) {
        const { px, py } = coordToPixel(o.x, o.y);
        const cx = Math.max(0, Math.min(IMAGE_SIZE, px));
        const cy = Math.max(0, Math.min(IMAGE_SIZE, py));
        const off = cx !== px || cy !== py;
        this.cross(cx, cy, 13, o.color);
        if (off) {
          ctx.strokeStyle = o.color;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(cx, cy, 17, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.fillStyle = o.color;
        ctx.font = "18px system-ui";
        ctx.fillText(o.label, cx + 16, cy + 6);
      }
    }

    // the marker for this frame (true position)
    if (opts.marker) {
      const { px, py } = coordToPixel(opts.marker.trueX, opts.marker.trueY);
      this.cross(px, py, 16, opts.marker.isAnchor ? "#ffd34d" : "#4cd0a0");
    }
  }

  private dot(px: number, py: number, r: number, color: string, label: string): void {
    const ctx = this.ctx;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(0,0,0,0.7)";
    ctx.font = "20px system-ui";
    ctx.fillText(label, px + r + 3, py - r);
  }

  private cross(px: number, py: number, s: number, color: string): void {
    const ctx = this.ctx;
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(px - s, py);
    ctx.lineTo(px + s, py);
    ctx.moveTo(px, py - s);
    ctx.lineTo(px, py + s);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(px, py, s * 0.55, 0, Math.PI * 2);
    ctx.stroke();
  }
}
