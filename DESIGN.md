# Eye-Tracking Calibration App — Design

A web app to manually create calibration anchors that map **raw eye-tracker coordinates → true gaze position in image space**, by scrubbing video frames and marking where the eyes truly were. It then **fits gaze-calibration models** from those anchors (including MoCET motion correction) and overlays each model's predicted gaze on the frame for comparison — see §9.

---

## 1. Architecture

**Cloudflare Pages (static SPA) + browser File System Access API.**

- The app is 100% client-side static assets hosted on Cloudflare Pages. No backend, no uploads, no R2.
- On first use the user grants the browser access to local directories:
  - `stimuli_by_frames/`  → frame folders (`R4DogF2/frame_0000.jpg`, …)
  - `data/`               → the session CSVs and the output anchor CSV
  - `fwd/` *(optional)*   → FSL motion files, auto-matched per session for MoCET
- Directory handles are persisted in **IndexedDB**, so the folders are remembered across sessions (the browser still shows a one-click re-grant prompt).
- All parsing, rendering, and the output CSV write happen in the browser. The output file is written **back into `data/`** next to the originals via the same API.

**Constraint:** File System Access API is Chromium-only → **Chrome or Edge on Windows**. That's fine for this workflow. (If cross-browser is ever needed, fall back to manual file-open + download, or the R2 path — out of scope now.)

```
Cloudflare Pages (HTML/JS/CSS static)
        │  served to browser
        ▼
   Browser (Chrome/Edge)
        │  File System Access API  (three picked folders)
        ▼
   stimuli_by_frames\<stim_id>\frame_####.jpg
   data\   (e.g. C:\Users\…\Eyetracker_local\data)
     ├─ <prefix>_eyetracker.csv / _raw_eyetrack.csv   (input; .edf ignored)
     ├─ <prefix>_full_log.csv                          (input)
     ├─ <prefix>_events.csv                            (input, optional)
     └─ <prefix>_calibration_anchors.csv               (OUTPUT)
   fwd\    (e.g. C:\Users\…\Eyetracker_local\fwd)
     └─ <prefix>_fwd.txt                               (FSL motion, auto-matched)

   <prefix> = D-sub-NN_ses-NN_task-EmoC_run-NN  (shared by all files of a session)
```

---

## 2. Data model

### Inputs (confirmed from the real files)

**`<session>_raw_eyetrack.csv`** *(or `<session>_eyetrack_rough_calibration.csv`)* — ~1000 Hz samples, timestamp in seconds starting at 0. Same column schema either way; the app uses whichever of the two files exists.
```
pos_x, pos_y, ps, timestamp, href_x, href_y, pupil_x, pupil_y, vel_x, vel_y
```
- `pos_x, pos_y` = eye position in **tracker/screen space** (e.g. ~510, ~1213) — NOT image pixels.
- ~300k rows / 5 min. Parsed once into typed arrays; nearest-sample lookup by **binary search on timestamp**.

**`<session>_full_log.csv`** — `type, onset, id`. The whole acquisition is rendered as **one continuous timeline** from this file (required). Each row is active from its `onset` until the next row's onset. By `type`:
- `stim` → frames from folder `id` (`<id>/frame_####.jpg`) at local frame `floor((t − onset)·fps)`.
- `attractor` → `others/attractor-0(id+1).png` (id `0`→`attractor-01.png`, … `8`→`attractor-09.png`).
- `baseline` (any id) → `others/baseline.png`.

Attractor/baseline images live in `stimuli_by_frames/others/`.

**`<session>_calibration_events.csv`** — known target positions at known times.
```
trial_number, x, y, timestamp
```
- Centered coordinate space (−400…400). Optional: seed anchors from these or use as a sanity overlay.

### Frame folders
`stimuli_by_frames/<stim_id>/frame_0000.jpg …` — **1080×1080**, ~97 frames/clip.

### Timing model (continuous timeline)
```
global_frame g  ↔  display_time t = g / fps          (fps = 30, fixed)
active event    = last full_log row with onset ≤ t
image           = stim frame / attractor / baseline  (per active event, above)
raw_sample      = nearest raw row to (t + delay)      (overlay only)
```
- One global frame grid spans the whole acquisition (≈ duration × fps frames).
- **delay** shifts only which raw sample is overlaid (reaction-time compensation); the displayed image stays at `t`. See §5.

---

## 3. UI layout

```
┌──────────────────────────────────────────────┬───────────────────────┐
│  Session: Alaska_rand1_…   Stim: R4DogF2 ▾    │  Anchors (table)      │
│  ┌──────────────────────────────────────────┐ │  ┌──────────────────┐ │
│  │                                          │ │  │ # stim  frm  t   │ │
│  │        FRAME CANVAS (1080×1080)          │ │  │ x_raw y_raw      │ │
│  │     • raw eye marker (mapped, preview)   │ │  │ x_true y_true    │ │
│  │     ✚ anchors (placed) + selected        │ │  │ …  (click→jump)  │ │
│  │                                          │ │  │                  │ │
│  └──────────────────────────────────────────┘ │  └──────────────────┘ │
│  ◀◀ ◀  frame 042/097  ▶ ▶▶   ▶play   onset… │  [Add] [Del] [Save CSV]│
│  fps:[30] delay:[-120 ms] ◀ ▶   preview xf… │  unsaved: 3            │
└──────────────────────────────────────────────┴───────────────────────┘
```

- **Center — frame canvas:** current frame drawn to `<canvas>`. Overlays:
  - **Raw eye marker** — the tracker reading at `frame_time`, mapped to image pixels via the **preview transform** (§4). Visual aid only.
  - **Anchors** — `✚` at each placed true position; the selected one highlighted/draggable.
- **Right — anchor table:** every anchor for the session, columns per §6. Click a row → jump to its stim+frame and select it. Shows unsaved-changes count.
- **Transport bar:** stim selector, frame stepper + counter, play/pause, current `frame_time`, **fps** field, **delay** field with steppers, preview-transform controls.

---

## 4. Preview transform (raw marker placement)

The raw `pos_x/pos_y` are in tracker space, not the 1080² image. To *show* the raw dot on the frame we apply an adjustable **affine preview transform** `(scale_x, scale_y, offset_x, offset_y[, rotation])`, editable in the UI and persisted per session.

- This is **purely visual** — it helps the user see roughly where the tracker thinks the eyes are. It is **not** the calibration.
- The real mapping is what the later regression learns from the anchors. Once enough anchors exist, the app can *optionally* fit a quick affine and use it as the live preview (nice-to-have, phase 2).
- Anchors store the **raw** sample values, so they're independent of whatever preview transform was active.

---

## 5. Delay control

`delay` shifts which raw sample pairs with the displayed frame: `frame_time = onset + idx/fps + delay`.

- Adjustable in the UI (steppers + keyboard), in **milliseconds**, can be negative.
- The user described it as "visualization only" — but note: because it changes which raw sample is captured into an anchor, the delay value is **recorded in each anchor row** (and as a session default) so the pairing is reproducible and the regression can account for it. Nothing is destructively applied to the raw data.

---

## 6. Output file

Written to `shared_data/` as **`<session>_calibration_anchors.csv`** (mirrors the input naming so it sorts next to them). One row per anchor:

```
global_frame, frame_time, fps, delay_ms, is_anchor,
event_type, event_id, stim_frame_index,
raw_pos_x, raw_pos_y, raw_timestamp,
true_x, true_y,           # centered image coords (±900), where the user clicked
created_at, note
```

`event_type`/`event_id`/`stim_frame_index` record what was on screen for the
labelled frame. The regression itself only needs the raw↔true pair, but these
columns are written for audit and to let work resume with full in-session
navigation context.

- `raw_pos_x/raw_pos_y` + `true_x/true_y` are the regression training pair.
- `raw_timestamp` = actual timestamp of the matched sample (for audit vs `frame_time`).
- Autosaved to **IndexedDB** continuously; explicit **Save CSV** writes the file. On load, an existing anchors CSV is re-imported so work resumes.

---

## 7. Keyboard shortcuts

| Key | Action |
|---|---|
| `←` / `→` | Previous / next frame |
| `Shift` + `←/→` | Jump ±10 frames |
| `[` / `]` | Previous / next stim segment |
| `Space` | Play / pause |
| Click on frame | Add anchor at click point (true position) |
| `A` | Add anchor at the current raw-marker position |
| `Ctrl` + `←/→/↑/↓` | Nudge selected anchor 1 px |
| `Ctrl`+`Shift` + arrows | Nudge selected anchor 10 px |
| `Delete` / `Backspace` | Remove selected anchor |
| `,` / `.` | Decrease / increase delay (step) |
| `Ctrl` + `S` | Save CSV |

(Plain arrows = frame nav; modified arrows = anchor nudge — avoids the conflict. All also exposed as on-screen buttons.)

---

## 8. Tech stack

- **Vite + TypeScript**, no heavy framework (or React if preferred — small UI either way).
- **PapaParse** for CSV parsing; manual writer for output.
- Canvas 2D for frame + overlays; `createImageBitmap` for fast frame decode, prefetch ±N neighbors.
- IndexedDB (via `idb`) for directory handles + autosave.
- Build → static assets → **Cloudflare Pages** (`npx wrangler pages deploy ./dist` or Git integration).

---

## 9. Calibration models (run & overlay)

After anchors exist, the **Calibrations** panel fits one or more gaze models and
draws each as a colored predicted-gaze cross on the frame (in addition to the raw
dot). Models are fit on **anchor** markers (`is_anchor`), with non-anchor markers
used as a validation set. All fitting is client-side least squares (normal
equations + ridge `1e-6`), implemented in [`src/calibrate.ts`](src/calibrate.ts);
motion handling in [`src/motion.ts`](src/motion.ts).

| Method | Model | Min anchors |
|---|---|---|
| **Affine** ("gross") | `true ~ [1, raw_x, raw_y]` | 3 |
| **Poly-2** | `true ~ [1, raw_x, raw_y, raw_x², raw_y², raw_x·raw_y]` | 6 |
| **MoCET** | two-stage (below) | 3 |
| **MoCET (FD-censored)** | MoCET, FD-flagged volumes excluded from stage 1 | 3 |

**MoCET** (Park et al.) is two-stage:
1. **Drift fit** over all eye samples: regress `raw_x` and `raw_y` on
   `D = [1, t, t², t³, m1..m6]` — cubic time + the 6 FSL/MCFLIRT motion
   parameters interpolated to sample time from the volume grid (`volume k @ k·TR`).
   The FD-censored variant drops samples whose volume's FD flag = 1.
2. **Corrected signal** = `raw − D·β` (residual; the stage-2 intercept absorbs DC).
3. **Gaze map**: affine `true ~ [1, corr_x, corr_y]` fit on anchors.
   Prediction at any frame = affine( raw − drift(t) ).

The FD binary column is **never** a regressor — only used for censoring/QC.

**Motion input.** A per-session FSL motion file (`<prefix>_fwd.txt`:
whitespace-separated, no header, 6 motion columns + optional 7th FD-flag column) is
**auto-matched by prefix** from the picked motion (`fwd/`) folder when a session
loads. A manual file upload (cached to IndexedDB `motion:<prefix>`) overrides the
auto-match. **TR** (s) is an editable per-session field (default 1.0) used for the
volume↔time mapping.

**Persistence & freshness.** Fitted models are stored in IndexedDB
(`calib:<prefix>`) and restored on load, so every computed calibration is kept
side-by-side (re-running a method replaces only that entry). Editing/adding anchors,
the motion file, or TR marks the affected models **stale** (badge shown) until re-run.
Per-method show/hide state lives in the session config (`cfg:<prefix>.visible`).

## 10. Open questions / TODO

1. **fps** — confirm the real clip frame rate (drives frame↔time mapping).
2. **Coordinate origin** — confirm `true_x/true_y` should be stored in image pixels (0–1080, origin top-left). The regression's target space can be chosen later.
3. **Raw→image preview** — is a manual affine enough to start, or seed from `_calibration_events` / `rough_calibration`?
4. **One anchor per frame** or multiple allowed? (Assumed: multiple allowed; table lists all.)
5. **Session selection** — pick by `_raw_eyetrack.csv` and auto-match companions by filename prefix (assumed yes).
6. **EDF eyetrack** — raw samples come as binary `_eyetracker.edf`; the app uses a CSV export (`_eyetracker.csv` / `_raw_eyetrack.csv`) instead. In-browser EDF parsing is out of scope.
