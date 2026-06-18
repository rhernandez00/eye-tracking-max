#!/usr/bin/env python
"""
Eye-Tracking Gaze Video Renderer
=================================
Renders an MP4 of a complete acquisition with gaze overlays (raw dot +
calibrated cross) drawn on top of the stimulus frames.

USAGE
-----
  1. Edit the CONFIG section below.
  2. Run:
       & "C:\\ProgramData\\anaconda3\\python.exe" render_gaze_video.py

DEPENDENCIES (all in Anaconda base)
-------------------------------------
  numpy, pandas, Pillow, opencv-python
  (install opencv if missing:  conda install -c conda-forge opencv)
"""

import bisect
import os
import sys
from pathlib import Path

import cv2
import numpy as np
import pandas as pd
from PIL import Image, ImageDraw


# ══════════════════════════════════════════════════════════════════════════════
#  CONFIG  —  edit these variables, then run the script
# ══════════════════════════════════════════════════════════════════════════════

# Folders -----------------------------------------------------------------
DATA_DIR     = r"C:\Users\raul_\Desktop\Eyetracker_local\data"               # folder containing session CSVs
STIMULI_DIR  = r"G:\My Drive\Networks\stimuli_by_frames"  # frame folders + others/

# Session identity --------------------------------------------------------
# The shared filename prefix for all CSV files of one session.
# Must match a <prefix>_full_log.csv and a <prefix>_eyetracker_raw_eyetrack.csv
# (or similar) in DATA_DIR.  Run the script with an empty prefix to list
# all sessions found in DATA_DIR.
SESSION_PREFIX = "H-sub-13_ses-01_task-EmoC_run-02"

# Timing ------------------------------------------------------------------
FPS       = 30    # display frame rate (matches the app)
DELAY_MS  = 0     # gaze sample delay offset in ms (same sign convention as the app)

# Preview transform  (raw tracker coords → image pixels) -----------------
# Used to display the raw gaze dot.  Match the values you set in the app.
# Set SHOW_RAW = False to skip the raw overlay entirely.
SHOW_RAW  = True
PT_SX     = 1.0   # scale x
PT_SY     = 1.0   # scale y
PT_OX     = 0.0   # offset x  (pixels)
PT_OY     = 0.0   # offset y  (pixels)
PT_FLIP_Y = False # flip Y axis

# Calibration overlay -----------------------------------------------------
# Requires <SESSION_PREFIX>_calibration_anchors.csv in DATA_DIR.
# CALIB_METHOD: "none" | "affine" | "poly2"
SHOW_CALIB   = True
CALIB_METHOD = "affine"   # "affine" or "poly2"

# Frame range (None = full acquisition) -----------------------------------
FRAME_START = None   # first global frame to render  (e.g. 0)
FRAME_END   = None   # last global frame (exclusive) (e.g. 9000)

# Output ------------------------------------------------------------------
# Leave OUTPUT_PATH empty ("") to auto-generate next to the data files.
OUTPUT_PATH  = r""
OUTPUT_SIZE  = 720   # output pixel size (square); 1080 = full res (large files)
OUTPUT_CRF   = 23    # 0 (lossless) … 51 (worst); 23 is a good default

# ══════════════════════════════════════════════════════════════════════════════
#  END CONFIG
# ══════════════════════════════════════════════════════════════════════════════

IMAGE_SIZE  = 1080   # stimulus frames are 1080×1080
COORD_RANGE = 900    # calibrated coords span –COORD_RANGE … +COORD_RANGE


# ── coordinate helpers ────────────────────────────────────────────────────────

def coord_to_pixel(cx: float, cy: float) -> tuple[int, int]:
    """Centered image coords → image pixel (0..IMAGE_SIZE)."""
    px = (cx + COORD_RANGE) / (2 * COORD_RANGE) * IMAGE_SIZE
    py = (cy + COORD_RANGE) / (2 * COORD_RANGE) * IMAGE_SIZE
    return int(round(px)), int(round(py))


def raw_to_pixel(rx: float, ry: float) -> tuple[int, int]:
    """Raw tracker coords → image pixel via the preview transform."""
    px = rx * PT_SX + PT_OX
    py = ((-ry) if PT_FLIP_Y else ry) * PT_SY + PT_OY
    return int(round(px)), int(round(py))


def scale_pt(px: int, py: int, scale: float) -> tuple[int, int]:
    """Scale a pixel coordinate from IMAGE_SIZE to OUTPUT_SIZE."""
    return int(round(px * scale)), int(round(py * scale))


# ── CSV loaders ───────────────────────────────────────────────────────────────

EYETRACK_SUFFIXES = [
    "_eyetracker_raw_eyetrack.csv",
    "_raw_eyetrack.csv",
    "_eyetrack_rough_calibration.csv",
    "_eyetracker.csv",
]


def list_available_sessions(data_dir: Path) -> list[str]:
    """Return all session prefixes that have both eyetrack and full_log CSVs."""
    import re
    eyetrack_re = re.compile(
        r"(_eyetracker)?_(raw_eyetrack|eyetrack_rough_calibration)\.csv$|_eyetracker\.csv$"
    )
    prefixes = set()
    for f in data_dir.iterdir():
        if eyetrack_re.search(f.name):
            prefix = eyetrack_re.sub("", f.name)
            if (data_dir / f"{prefix}_full_log.csv").exists():
                prefixes.add(prefix)
    return sorted(prefixes)


def load_eyetrack(data_dir: Path, prefix: str) -> pd.DataFrame:
    for suffix in EYETRACK_SUFFIXES:
        path = data_dir / f"{prefix}{suffix}"
        if path.exists():
            print(f"  eyetrack: {path.name}")
            return pd.read_csv(path)
    available = list_available_sessions(data_dir)
    hint = "\n  Available sessions:\n" + "\n".join(f"    {s}" for s in available) if available else ""
    sys.exit(f"ERROR: no eyetrack CSV found for prefix '{prefix}' in {data_dir}{hint}")


def load_timeline(data_dir: Path, prefix: str) -> pd.DataFrame:
    path = data_dir / f"{prefix}_full_log.csv"
    if not path.exists():
        sys.exit(f"ERROR: missing {path}")
    print(f"  timeline: {path.name}")
    df = pd.read_csv(path)
    df.columns = [c.strip().lower() for c in df.columns]
    return df


def load_anchors(data_dir: Path, prefix: str) -> pd.DataFrame | None:
    path = data_dir / f"{prefix}_calibration_anchors.csv"
    if not path.exists():
        print(f"  anchors:  not found — calibrated overlay disabled")
        return None
    print(f"  anchors:  {path.name}")
    return pd.read_csv(path)


# ── calibration fitting ───────────────────────────────────────────────────────

def _design_affine(rx: np.ndarray, ry: np.ndarray) -> np.ndarray:
    return np.column_stack([np.ones(len(rx)), rx, ry])


def _design_poly2(rx: np.ndarray, ry: np.ndarray) -> np.ndarray:
    return np.column_stack([np.ones(len(rx)), rx, ry, rx**2, ry**2, rx * ry])


def fit_calibration(anchors: pd.DataFrame, method: str):
    """
    Returns (predict_fn) where predict_fn(raw_x, raw_y) -> (true_x, true_y).
    Returns None if not enough anchors.
    """
    anchor_rows = anchors[anchors["is_anchor"].astype(str).str.lower().isin(["true", "1"])]
    anchor_rows = anchor_rows.dropna(subset=["raw_pos_x", "raw_pos_y", "true_x", "true_y"])

    min_n = 3 if method == "affine" else 6
    if len(anchor_rows) < min_n:
        print(f"  WARNING: only {len(anchor_rows)} anchors — need {min_n} for {method}; skipping calib overlay")
        return None

    rx = anchor_rows["raw_pos_x"].values.astype(float)
    ry = anchor_rows["raw_pos_y"].values.astype(float)
    tx = anchor_rows["true_x"].values.astype(float)
    ty = anchor_rows["true_y"].values.astype(float)

    design_fn = _design_affine if method == "affine" else _design_poly2
    X = design_fn(rx, ry)
    lam = 1e-6
    A = X.T @ X + lam * np.eye(X.shape[1])
    gx = np.linalg.solve(A, X.T @ tx)
    gy = np.linalg.solve(A, X.T @ ty)

    # RMSE on training set
    pred_x = X @ gx
    pred_y = X @ gy
    rmse = float(np.sqrt(np.mean((pred_x - tx) ** 2 + (pred_y - ty) ** 2)))
    print(f"  {method} fit: {len(anchor_rows)} anchors, RMSE = {rmse:.1f} coord units")

    def predict(raw_x: float, raw_y: float) -> tuple[float, float]:
        feat = design_fn(np.array([raw_x]), np.array([raw_y]))[0]
        return float(feat @ gx), float(feat @ gy)

    return predict


# ── nearest sample lookup ─────────────────────────────────────────────────────

# How far (in seconds) from the requested time a sample may be before we
# treat it as "no data" (tracking loss / blink gap).  200 ms is generous but
# avoids drawing stale gaze during long interruptions.
MAX_SAMPLE_GAP_S = 0.200

def build_sample_arrays(df: pd.DataFrame):
    ts = df["timestamp"].values.astype(float)
    xs = df["pos_x"].values.astype(float)
    ys = df["pos_y"].values.astype(float)
    # Drop rows where either coordinate is NaN (blink / loss-of-tracking periods)
    valid = np.isfinite(xs) & np.isfinite(ys)
    n_total = len(ts)
    n_valid = int(valid.sum())
    n_dropped = n_total - n_valid
    if n_dropped > 0:
        pct = 100 * n_dropped / n_total
        print(f"  WARNING: {n_dropped:,} / {n_total:,} samples ({pct:.1f}%) have NaN coordinates "
              f"(blinks / tracking loss) — those frames will have no gaze overlay")
    return ts[valid], xs[valid], ys[valid]


def nearest_sample(ts: np.ndarray, xs: np.ndarray, ys: np.ndarray, t: float):
    n = len(ts)
    if n == 0:
        return None
    i = bisect.bisect_left(ts, t)
    if i == 0:
        idx = 0
    elif i >= n:
        idx = n - 1
    else:
        idx = i if abs(ts[i] - t) <= abs(ts[i - 1] - t) else i - 1
    # If the nearest valid sample is too far away, treat this frame as no-data
    if abs(ts[idx] - t) > MAX_SAMPLE_GAP_S:
        return None
    return float(xs[idx]), float(ys[idx])


# ── timeline resolution ────────────────────────────────────────────────────────

def build_events(df: pd.DataFrame, duration: float) -> list[dict]:
    df = df.copy()
    df.columns = [c.strip().lower() for c in df.columns]
    # normalise column names: accept 'type'/'event_type', 'id'/'event_id', 'onset'
    col_map = {}
    for col in df.columns:
        if col in ("type", "event_type"):
            col_map[col] = "type"
        elif col in ("id", "event_id", "stim_id"):
            col_map[col] = "id"
        elif col in ("onset",):
            col_map[col] = "onset"
    df = df.rename(columns=col_map)
    df = df.sort_values("onset").reset_index(drop=True)
    events = df[["type", "id", "onset"]].copy()
    events["id"] = events["id"].astype(str)
    ends = list(events["onset"].iloc[1:]) + [duration]
    events["end"] = ends
    return events.to_dict("records")


def active_event(events: list[dict], t: float) -> dict | None:
    lo, hi = 0, len(events) - 1
    while lo <= hi:
        mid = (lo + hi) // 2
        if events[mid]["onset"] <= t:
            lo = mid + 1
        else:
            hi = mid - 1
    idx = lo - 1
    return events[idx] if idx >= 0 else None


def resolve_frame(events: list[dict], g: int, stim_frame_counts: dict[str, int]) -> dict | None:
    t = g / FPS
    ev = active_event(events, t)
    if ev is None:
        return None
    et = ev["type"]
    eid = ev["id"]
    if et == "stim":
        n_frames = stim_frame_counts.get(eid, -1)
        local = int((t - ev["onset"]) * FPS)
        local = max(0, local)
        if n_frames > 0:
            local = min(local, n_frames - 1)
        return {"type": "stim", "id": eid, "folder": eid,
                "file": f"frame_{local:04d}.jpg"}
    if et == "attractor":
        try:
            n = int(eid)
            fname = f"attractor-{(n + 1):02d}.png"
        except ValueError:
            fname = f"attractor-{eid}.png"
        return {"type": "attractor", "id": eid, "folder": "others", "file": fname}
    # baseline / anything else
    return {"type": et, "id": eid, "folder": "others", "file": "baseline.png"}


def count_stim_frames(stimuli_dir: Path, stim_id: str) -> int:
    folder = stimuli_dir / stim_id
    if not folder.is_dir():
        return 0
    return sum(1 for f in folder.iterdir() if f.suffix.lower() in (".jpg", ".jpeg", ".png"))


# ── image cache ───────────────────────────────────────────────────────────────

_img_cache: dict[str, Image.Image | None] = {}


def get_image(stimuli_dir: Path, folder: str, filename: str) -> Image.Image | None:
    key = f"{folder}/{filename}"
    if key in _img_cache:
        return _img_cache[key]
    path = stimuli_dir / folder / filename
    if not path.exists():
        _img_cache[key] = None
        return None
    try:
        img = Image.open(path).convert("RGB")
        if img.size != (IMAGE_SIZE, IMAGE_SIZE):
            img = img.resize((IMAGE_SIZE, IMAGE_SIZE), Image.LANCZOS)
    except Exception as e:
        print(f"  WARNING: could not load {path}: {e}")
        img = None
    _img_cache[key] = img
    # keep cache bounded
    if len(_img_cache) > 200:
        oldest = next(iter(_img_cache))
        del _img_cache[oldest]
    return img


# ── drawing helpers ────────────────────────────────────────────────────────────

def draw_dot(draw: ImageDraw.ImageDraw, px: int, py: int, r: int, color: str, label: str) -> None:
    draw.ellipse([px - r, py - r, px + r, py + r], fill=color)
    draw.text((px + r + 3, py - r), label, fill=color)


def draw_cross(draw: ImageDraw.ImageDraw, px: int, py: int, s: int, color: str) -> None:
    draw.line([(px - s, py), (px + s, py)], fill=color, width=3)
    draw.line([(px, py - s), (px, py + s)], fill=color, width=3)
    r = int(s * 0.55)
    draw.ellipse([px - r, py - r, px + r, py + r], outline=color, width=3)


def draw_marker(draw: ImageDraw.ImageDraw, px: int, py: int, is_anchor: bool) -> None:
    color = "#ffd34d" if is_anchor else "#4cd0a0"
    draw_cross(draw, px, py, 16, color)


def clamp(v: int, lo: int, hi: int) -> int:
    return max(lo, min(hi, v))


# ── video writer ───────────────────────────────────────────────────────────────

def open_writer(output_path: str, size: int, fps: int) -> cv2.VideoWriter:
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")  # type: ignore[attr-defined]
    writer = cv2.VideoWriter(output_path, fourcc, fps, (size, size))
    if not writer.isOpened():
        sys.exit(f"ERROR: could not open video writer for '{output_path}'")
    return writer


def pil_to_cv2(img: Image.Image) -> np.ndarray:
    return cv2.cvtColor(np.array(img), cv2.COLOR_RGB2BGR)  # type: ignore[attr-defined]


# ── main ───────────────────────────────────────────────────────────────────────

def main() -> None:
    data_dir    = Path(DATA_DIR)
    stimuli_dir = Path(STIMULI_DIR)

    # Validate paths
    for p, label in [(data_dir, "DATA_DIR"), (stimuli_dir, "STIMULI_DIR")]:
        if not p.is_dir():
            sys.exit(f"ERROR: {label} = '{p}' is not a directory")

    # If SESSION_PREFIX is empty, list available sessions and exit
    if not SESSION_PREFIX.strip():
        sessions = list_available_sessions(data_dir)
        if sessions:
            print("Available sessions in DATA_DIR:")
            for s in sessions:
                print(f"  {s}")
        else:
            print("No sessions with both eyetrack + full_log CSVs found in DATA_DIR.")
        sys.exit(0)

    # Auto-generate output path if not set
    if OUTPUT_PATH.strip():
        output_path = Path(OUTPUT_PATH)
    else:
        output_path = data_dir / f"{SESSION_PREFIX}_gaze_video.mp4"

    output_path.parent.mkdir(parents=True, exist_ok=True)

    print("=" * 60)
    print(f"Session : {SESSION_PREFIX}")
    print(f"Output  : {output_path}")
    print("=" * 60)
    print("Loading data…")

    # Load CSVs
    raw_df  = load_eyetrack(data_dir, SESSION_PREFIX)
    tl_df   = load_timeline(data_dir, SESSION_PREFIX)
    anchors = load_anchors(data_dir, SESSION_PREFIX) if SHOW_CALIB else None

    # Build fast lookup structures
    ts, xs, ys = build_sample_arrays(raw_df)
    duration   = float(ts[-1]) if len(ts) else 0.0
    events     = build_events(tl_df, duration)
    n_frames   = int(duration * FPS) + 1

    print(f"  {len(ts):,} raw samples, {duration:.1f}s, {n_frames:,} frames @ {FPS} fps")
    print(f"  {len(events)} timeline events")

    # Fit calibration
    predict_gaze = None
    if SHOW_CALIB and anchors is not None and CALIB_METHOD != "none":
        predict_gaze = fit_calibration(anchors, CALIB_METHOD)

    # Pre-scan stim frame counts (only unique stim ids)
    stim_ids = {e["id"] for e in events if e["type"] == "stim"}
    stim_frame_counts: dict[str, int] = {}
    for sid in stim_ids:
        stim_frame_counts[sid] = count_stim_frames(stimuli_dir, sid)
    print(f"  {len(stim_ids)} stim clips")

    # Frame range
    g_start = int(FRAME_START) if FRAME_START is not None else 0
    g_end   = int(FRAME_END)   if FRAME_END   is not None else n_frames
    g_end   = min(g_end, n_frames)
    total   = g_end - g_start
    print(f"  Rendering frames {g_start}–{g_end - 1} ({total:,} frames)")

    scale = OUTPUT_SIZE / IMAGE_SIZE

    # Black fallback image
    black = Image.new("RGB", (IMAGE_SIZE, IMAGE_SIZE), (0, 0, 0))

    writer = open_writer(str(output_path), OUTPUT_SIZE, FPS)
    print(f"\nRendering…")

    for i, g in enumerate(range(g_start, g_end)):
        if i % 300 == 0:
            pct = 100 * i / total
            print(f"  frame {g:6d} / {g_end - 1}  ({pct:.1f}%)")

        # ── get base image ──
        resolved = resolve_frame(events, g, stim_frame_counts)
        if resolved:
            bmp = get_image(stimuli_dir, resolved["folder"], resolved["file"])
        else:
            bmp = None
        frame_img = (bmp or black).copy()

        # ── get raw gaze sample ──
        t = g / FPS + DELAY_MS / 1000.0
        sample = nearest_sample(ts, xs, ys, t) if len(ts) > 0 else None

        # ── draw overlays ──
        draw = ImageDraw.Draw(frame_img)

        # center crosshair
        cx_color = (50, 50, 50)
        draw.line([(IMAGE_SIZE // 2, 0), (IMAGE_SIZE // 2, IMAGE_SIZE)], fill=cx_color, width=1)
        draw.line([(0, IMAGE_SIZE // 2), (IMAGE_SIZE, IMAGE_SIZE // 2)], fill=cx_color, width=1)

        if sample is not None:
            rx, ry = sample

            # raw gaze dot
            if SHOW_RAW:
                rpx, rpy = raw_to_pixel(rx, ry)
                rpx_c = clamp(rpx, 0, IMAGE_SIZE)
                rpy_c = clamp(rpy, 0, IMAGE_SIZE)
                offscreen = rpx_c != rpx or rpy_c != rpy
                draw_dot(draw, rpx_c, rpy_c, 9, "#ff5d7a", "raw ›" if offscreen else "raw")
                if offscreen:
                    r = 14
                    draw.ellipse([rpx_c - r, rpy_c - r, rpx_c + r, rpy_c + r],
                                 outline="#ff5d7a", width=2)

            # calibrated gaze cross
            if predict_gaze is not None:
                try:
                    cx, cy = predict_gaze(rx, ry)
                    cpx, cpy = coord_to_pixel(cx, cy)
                    cpx_c = clamp(cpx, 0, IMAGE_SIZE)
                    cpy_c = clamp(cpy, 0, IMAGE_SIZE)
                    off = cpx_c != cpx or cpy_c != cpy
                    draw_cross(draw, cpx_c, cpy_c, 13, "#4aa3ff")
                    draw.text((cpx_c + 16, cpy_c + 6), CALIB_METHOD, fill="#4aa3ff")
                    if off:
                        r = 17
                        draw.ellipse([cpx_c - r, cpy_c - r, cpx_c + r, cpy_c + r],
                                     outline="#4aa3ff", width=2)
                except Exception:
                    pass

        # ── scale and write ──
        if OUTPUT_SIZE != IMAGE_SIZE:
            frame_img = frame_img.resize((OUTPUT_SIZE, OUTPUT_SIZE), Image.LANCZOS)

        writer.write(pil_to_cv2(frame_img))

    writer.release()
    print(f"\nDone! Video saved to: {output_path}")
    size_mb = output_path.stat().st_size / 1024 / 1024
    print(f"  File size: {size_mb:.1f} MB")


if __name__ == "__main__":
    main()
