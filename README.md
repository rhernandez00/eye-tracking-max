# Eye-Tracking Calibration

Web app to manually label the "true" gaze position over stimulus frames and export
calibration anchors (`raw tracker coords → true image coords`) for a later regression.

See [DESIGN.md](DESIGN.md) for the full spec.

## Run locally

```bash
npm install
npm run dev          # http://localhost:5173  (use Chrome or Edge)
```

The app reads/writes files directly from disk via the **File System Access API**
(Chromium only). On first use:

1. Click **📁 stimuli_by_frames…** and pick `G:\My Drive\Networks\stimuli_by_frames`.
2. Click **📁 shared_data…** and pick `G:\My Drive\Networks\shared_data`.
3. Choose a session (any `*_raw_eyetrack.csv` or `*_eyetrack_rough_calibration.csv`) and **Load**.

Folders are remembered between sessions (one-click re-grant prompt).

## Workflow

- Pick a **stim** and set its **onset** (auto-filled from `_full_log.csv` when that
  file exists; otherwise choose a frame folder and type the onset in seconds).
- Scrub frames; the red dot is the raw tracker reading at `onset + frame/fps + delay`,
  placed via the visual-only **preview transform**.
- **Click** the frame to drop/move a marker at the true gaze position.
- One marker per frame, flagged **normal** or **anchor**.
- **Save CSV** writes `<session>_calibration_anchors.csv` next to the inputs.

### Shortcuts

| Key | Action |
|---|---|
| `←` / `→` | prev / next frame (`Shift` = ±10) |
| `[` / `]` | prev / next stim |
| `Space` | play / pause |
| `Home` / `End` | first / last frame |
| click | place/move marker (keeps its type) |
| `a` | add **normal** marker at raw position |
| `A` (Shift+a) | add **anchor** marker at raw position |
| `t` | toggle anchor flag |
| `Ctrl`+arrows | nudge marker 1 px (`+Shift` = 10 px) |
| `Delete` | remove marker |
| `,` / `.` | delay − / + step |
| `Ctrl`+`S` | save CSV |

## Deploy to Cloudflare Pages

```bash
npm run build                       # -> dist/
npx wrangler pages deploy ./dist    # or connect the repo in the Pages dashboard
```

The app is fully static; all data stays on the user's machine (no uploads).
Because it relies on the File System Access API, it must be opened in Chrome/Edge.

## Output columns

`stim_id, frame_index, frame_time, fps, delay_ms, is_anchor, raw_pos_x, raw_pos_y,
raw_timestamp, true_x, true_y, created_at, note`

`true_x/true_y` are centered image coords (origin = image center, range ±900).
