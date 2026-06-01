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

    // raw eye marker (preview)
    if (opts.rawX != null && opts.rawY != null) {
      const { px, py } = rawToPixel(opts.rawX, opts.rawY, opts.pt);
      this.dot(px, py, 9, "#ff5d7a", "raw");
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
