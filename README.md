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

1. Click **📁 stimuli_by_frames…** and pick the frame-folders directory.
2. Click **📁 data…** and pick the session-data directory
   (e.g. `C:\Users\raul_\Desktop\Eyetracker_local\data`) — holds the eyetrack CSV,
   `_full_log.csv`, and the output anchors CSV.
3. *(optional, for MoCET)* Click **📁 motion (fwd)…** and pick the FSL motion
   directory (e.g. `C:\Users\raul_\Desktop\Eyetracker_local\fwd`). The matching
   `<session>_fwd.txt` is then auto-loaded per session.
4. Choose a session (any `*_raw_eyetrack.csv`, `*_eyetrack_rough_calibration.csv`,
   or `*_eyetracker.csv`) and **Load**.

Session files share one prefix (e.g. `D-sub-01_ses-01_task-EmoC_run-05`), and the
motion file is `<prefix>_fwd.txt`. Binary `.edf` eyetracker files are ignored — the
app uses the CSV eyetrack export. Folders are remembered between sessions
(one-click re-grant prompt).

## Workflow

The whole session plays as **one continuous ~5-min timeline** built from
`_full_log.csv`: scrubbing through time shows whatever was on screen — a stim clip's
frame, an attractor image, or the baseline image (`stimuli_by_frames/others/`).

- Scrub with the timeline slider / arrow keys; **Jump to stim** dropdown for quick nav.
- The red dot is the raw tracker reading at `t + delay`, placed via the visual-only
  **preview transform**.
- **Click** the frame to drop/move a marker at the true gaze position.
- One marker per global frame, flagged **normal** or **anchor**.
- **Save CSV** writes `<session>_calibration_anchors.csv` next to the inputs.

### Calibration (run & overlay)

Once you have anchors, the **Calibrations** panel (under the stage) fits gaze
models from them and draws each as a colored predicted-gaze cross on the frame,
alongside the red raw dot. Every computed model is kept side-by-side and can be
shown/hidden independently; each shows its 2-D RMSE (training, and validation on
non-anchor markers) and a ⚠ **stale** badge when anchors/motion/TR change after a fit.

| Method | Predictors | Min anchors |
|---|---|---|
| **Affine** | `1, raw_x, raw_y` (the basic "gross" fit) | 3 |
| **Poly-2** | adds `raw_x², raw_y², raw_x·raw_y` | 6 |
| **MoCET** | de-drift `raw` with 6 FSL motion params + cubic time, then affine | 3 |
| **MoCET (FD-censored)** | same, excluding FD-flagged volumes from the drift fit | 3 |

For the two MoCET methods the session's FSL/MCFLIRT motion file
(`<prefix>_fwd.txt`: 6 motion columns + optional 7th FD-flag column, no header) is
**auto-loaded** from the motion folder by matching the session prefix; you can also
**upload** one manually to override. Set the **TR** (s) so volume index → time.
Fitted models are cached per session, so they survive a reload.

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

`global_frame, frame_time, fps, delay_ms, is_anchor, event_type, event_id,
stim_frame_index, raw_pos_x, raw_pos_y, raw_timestamp, true_x, true_y, created_at, note`

`true_x/true_y` are centered image coords (origin = image center, range ±900).
