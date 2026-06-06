import "./style.css";
import {
  pickStimuliDir,
  pickSharedDir,
  pickMotionDir,
  restoreStimuliDir,
  restoreSharedDir,
  restoreMotionDir,
  ensurePermission,
  readTextFile,
  writeTextFile,
  fileExists,
  listFiles,
  countFrames,
  loadImageFile,
  DirHandle,
} from "./fsaccess";
import { parseRawEyetrack, nearestSample, parseTimeline, activeEventIndex } from "./csv";
import { MarkerStore, markersToCsv, markersFromCsv } from "./markers";
import { Renderer } from "./render";
import { pixelToCoord, coordToPixel, rawToPixel, clampPixel } from "./coords";
import { idbGet, idbSet } from "./idb";
import { parseMotion, fdCount } from "./motion";
import { fitAffine, fitPoly2, fitMoCET, predictGaze, FitResult } from "./calibrate";
import {
  Marker,
  PreviewTransform,
  RawEyetrack,
  TimelineEvent,
  MotionData,
  CalibKind,
  CalibrationModel,
  CALIB_KINDS,
  CALIB_META,
  MOCET_POLY_ORDER,
} from "./types";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// Newer exports prefix the eyetrack files with an extra `_eyetracker` segment
// (e.g. `<session>_eyetracker_raw_eyetrack.csv`); older ones don't. Accept both
// and derive the same session prefix either way. List the longer suffixes first
// so loadSession() reconstructs the real filename; `_eyetracker.csv` is the bare
// rough-calibration export some sessions ship instead.
const EYETRACK_SUFFIXES = [
  "_eyetracker_raw_eyetrack.csv",
  "_raw_eyetrack.csv",
  "_eyetrack_rough_calibration.csv",
  "_eyetracker.csv",
];
const EYETRACK_RE = /(_eyetracker)?_(raw_eyetrack|eyetrack_rough_calibration)\.csv$|_eyetracker\.csv$/;
const OTHERS_DIR = "others";
const BASELINE_FILE = "baseline.png";

/** What is on screen at a given global frame. */
interface Resolved {
  eventType: string;
  eventId: string;
  stimFrameIndex: number; // -1 for attractor/baseline
  folder: string;
  fileName: string;
}

// ---------- state ----------
let stimuliDir: DirHandle | null = null;
let sharedDir: DirHandle | null = null;
let motionDir: DirHandle | null = null;

let sessionPrefix = "";
let raw: RawEyetrack | null = null;
let events: TimelineEvent[] = [];
const stimFrameCounts = new Map<string, number>();

const store = new MarkerStore();
let pt: PreviewTransform = { sx: 1, sy: 1, ox: 0, oy: 0, flipY: false };
let fps = 30;
let delayMs = 0;
let delayStep = 10;

// ---- calibration ----
let motion: MotionData | null = null;
let motionName = "";
let tr = 1.0;
const models = new Map<CalibKind, CalibrationModel>();
const visible = new Set<CalibKind>();

let duration = 0; // acquisition length (s)
let globalFrameCount = 0;
let globalFrame = 0;
let current: Resolved | null = null;

let renderer: Renderer;
let frameToken = 0;
const bmpCache = new Map<string, ImageBitmap>();
let playTimer: number | null = null;

// ---------- helpers ----------
const displayTime = (g: number): number => g / fps;

function rawSampleAt(g: number): { x: number; y: number; t: number } | null {
  if (!raw || raw.n === 0) return null;
  const i = nearestSample(raw, displayTime(g) + delayMs / 1000);
  if (i < 0) return null;
  return { x: raw.x[i], y: raw.y[i], t: raw.t[i] };
}

function resolve(g: number): Resolved | null {
  if (!events.length) return null;
  const t = displayTime(g);
  const i = activeEventIndex(events, t);
  if (i < 0) return null;
  const ev = events[i];
  if (ev.type === "stim") {
    const count = stimFrameCounts.get(ev.id) ?? -1;
    let local = Math.floor((t - ev.onset) * fps);
    if (local < 0) local = 0;
    if (count > 0 && local >= count) local = count - 1;
    return {
      eventType: "stim",
      eventId: ev.id,
      stimFrameIndex: local,
      folder: ev.id,
      fileName: `frame_${String(local).padStart(4, "0")}.jpg`,
    };
  }
  if (ev.type === "attractor") {
    const n = parseInt(ev.id, 10);
    const fileName = isNaN(n)
      ? `attractor-${ev.id}.png`
      : `attractor-${String(n + 1).padStart(2, "0")}.png`;
    return { eventType: "attractor", eventId: ev.id, stimFrameIndex: -1, folder: OTHERS_DIR, fileName };
  }
  // baseline (and any other type) -> baseline image
  return {
    eventType: ev.type || "baseline",
    eventId: ev.id,
    stimFrameIndex: -1,
    folder: OTHERS_DIR,
    fileName: BASELINE_FILE,
  };
}

function toast(msg: string): void {
  const el = $("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  window.clearTimeout((el as any)._t);
  (el as any)._t = window.setTimeout(() => el.classList.add("hidden"), 2200);
}

function setDirty(dirty: boolean): void {
  store.dirty = dirty;
  const b = $("unsaved");
  b.textContent = dirty ? `${store.size} • unsaved` : "saved";
  b.classList.toggle("dirty", dirty);
}

// ---------- init ----------
async function init(): Promise<void> {
  renderer = new Renderer($("frame-canvas") as HTMLCanvasElement);
  wireSetup();
  wireControls();
  wireShortcuts();

  stimuliDir = await restoreStimuliDir();
  sharedDir = await restoreSharedDir();
  motionDir = await restoreMotionDir();
  if (stimuliDir) $("pick-stimuli").textContent = `📁 ${stimuliDir.name} ✓`;
  if (sharedDir) $("pick-shared").textContent = `📁 ${sharedDir.name} ✓`;
  if (motionDir) $("pick-motion").textContent = `📁 ${motionDir.name} ✓`;
  if (sharedDir) await refreshSessionList();
}

function wireSetup(): void {
  $("pick-stimuli").addEventListener("click", async () => {
    stimuliDir = await pickStimuliDir();
    $("pick-stimuli").textContent = `📁 ${stimuliDir.name} ✓`;
  });
  $("pick-shared").addEventListener("click", async () => {
    sharedDir = await pickSharedDir();
    $("pick-shared").textContent = `📁 ${sharedDir.name} ✓`;
    await refreshSessionList();
  });
  $("pick-motion").addEventListener("click", async () => {
    motionDir = await pickMotionDir();
    $("pick-motion").textContent = `📁 ${motionDir.name} ✓`;
    if (sessionPrefix) {
      await loadCalibration(sessionPrefix);
      redraw();
    }
  });
  $("load-session").addEventListener("click", () => loadSession());
  $<HTMLSelectElement>("session-select").addEventListener("change", (e) => {
    $<HTMLButtonElement>("load-session").disabled = !(e.target as HTMLSelectElement).value;
  });
}

async function refreshSessionList(): Promise<void> {
  if (!sharedDir) return;
  if (!(await ensurePermission(sharedDir, "readwrite"))) {
    $("setup-status").textContent = "permission needed for shared_data";
    return;
  }
  const files = await listFiles(sharedDir);
  const sessions = [
    ...new Set(
      files.filter((f) => EYETRACK_SUFFIXES.some((s) => f.endsWith(s))).map((f) => f.replace(EYETRACK_RE, ""))
    ),
  ].sort();
  const sel = $<HTMLSelectElement>("session-select");
  sel.innerHTML = '<option value="">— select session —</option>';
  for (const s of sessions) {
    const o = document.createElement("option");
    o.value = s;
    o.textContent = s;
    sel.appendChild(o);
  }
  sel.disabled = sessions.length === 0;
  $("setup-status").textContent = `${sessions.length} session(s)`;
}

// ---------- session loading ----------
async function loadSession(): Promise<void> {
  if (!sharedDir) return toast("pick shared_data first");
  if (!stimuliDir) return toast("pick stimuli_by_frames first");
  const prefix = $<HTMLSelectElement>("session-select").value;
  if (!prefix) return;
  if (!(await ensurePermission(stimuliDir, "read"))) return toast("need stimuli permission");

  $("setup-status").textContent = "loading…";
  sessionPrefix = prefix;

  // eyetrack samples
  let eyetrackName = "";
  for (const s of EYETRACK_SUFFIXES) {
    if (await fileExists(sharedDir, `${prefix}${s}`)) {
      eyetrackName = `${prefix}${s}`;
      break;
    }
  }
  if (!eyetrackName) return toast("no eyetrack csv found");
  raw = parseRawEyetrack(await readTextFile(sharedDir, eyetrackName));
  duration = raw.n ? raw.t[raw.n - 1] : 0;

  // timeline (required)
  if (!(await fileExists(sharedDir, `${prefix}_full_log.csv`))) {
    return toast("missing _full_log.csv — needed for the timeline");
  }
  events = parseTimeline(await readTextFile(sharedDir, `${prefix}_full_log.csv`), duration);
  stimFrameCounts.clear();

  // restore per-session config
  const cfg = await idbGet<any>(`cfg:${prefix}`);
  if (cfg) {
    fps = cfg.fps ?? 30;
    delayMs = cfg.delayMs ?? 0;
    pt = cfg.pt ?? pt;
    tr = cfg.tr ?? 1.0;
  } else {
    tr = 1.0;
  }
  visible.clear();
  for (const k of (cfg?.visible ?? []) as CalibKind[]) visible.add(k);
  applyCfgToInputs();
  recomputeTimeline();

  await loadMarkers(prefix);
  await loadCalibration(prefix);
  populateStimJump();

  $("workspace").classList.remove("hidden");
  $("setup-status").textContent = `loaded ${prefix} (${raw.n} samples, ${events.length} events)`;

  globalFrame = 0;
  bmpCache.clear();
  await showFrame();
  renderTable();
}

function recomputeTimeline(): void {
  globalFrameCount = Math.max(1, Math.floor(duration * fps) + 1);
  const tl = $<HTMLInputElement>("timeline");
  tl.max = String(globalFrameCount - 1);
}

async function loadMarkers(prefix: string): Promise<void> {
  const outName = `${prefix}_calibration_anchors.csv`;
  if (await fileExists(sharedDir!, outName)) {
    store.load(markersFromCsv(await readTextFile(sharedDir!, outName)));
  } else {
    store.load((await idbGet<Marker[]>(`session:${prefix}`)) ?? []);
  }
  setDirty(false);
}

function populateStimJump(): void {
  const sel = $<HTMLSelectElement>("stim-select");
  sel.innerHTML = '<option value="">— jump to stim —</option>';
  for (const ev of events) {
    if (ev.type !== "stim") continue;
    const o = document.createElement("option");
    o.value = String(ev.index);
    o.textContent = `${ev.onset.toFixed(2)}s  ${ev.id}`;
    sel.appendChild(o);
  }
}

// ---------- frame display ----------
async function getBitmap(folder: string, fileName: string): Promise<ImageBitmap | null> {
  const key = `${folder}/${fileName}`;
  const hit = bmpCache.get(key);
  if (hit) return hit;
  try {
    const bmp = await loadImageFile(stimuliDir!, folder, fileName);
    bmpCache.set(key, bmp);
    if (bmpCache.size > 80) {
      const first = bmpCache.keys().next().value as string;
      bmpCache.delete(first);
    }
    return bmp;
  } catch {
    return null;
  }
}

async function ensureStimCount(g: number): Promise<void> {
  const i = activeEventIndex(events, displayTime(g));
  if (i < 0) return;
  const ev = events[i];
  if (ev.type === "stim" && !stimFrameCounts.has(ev.id)) {
    stimFrameCounts.set(ev.id, await countFrames(stimuliDir!, ev.id));
  }
}

async function showFrame(): Promise<void> {
  const token = ++frameToken;
  await ensureStimCount(globalFrame);
  if (token !== frameToken) return;

  current = resolve(globalFrame);
  let bmp: ImageBitmap | null = null;
  if (current) bmp = await getBitmap(current.folder, current.fileName);
  if (token !== frameToken) return;

  renderer.setFrame(bmp);
  redraw();
  updateFrameInfo();

  // prefetch next
  const rn = resolve(globalFrame + 1);
  if (rn) getBitmap(rn.folder, rn.fileName);
}

function redraw(): void {
  const s = rawSampleAt(globalFrame);
  const overlays: { x: number; y: number; color: string; label: string }[] = [];
  if (s) {
    for (const kind of CALIB_KINDS) {
      if (!visible.has(kind)) continue;
      const model = models.get(kind);
      if (!model) continue;
      const p = predictGaze(model, s.x, s.y, s.t, motion);
      overlays.push({ x: p.x, y: p.y, color: CALIB_META[kind].color, label: CALIB_META[kind].label });
    }
  }
  renderer.draw({
    rawX: s ? s.x : null,
    rawY: s ? s.y : null,
    pt,
    marker: store.get(globalFrame) ?? null,
    overlays,
  });
  updateMarkerInfo();
}

function updateFrameInfo(): void {
  $("frame-info").textContent = `${globalFrameCount ? globalFrame + 1 : 0} / ${globalFrameCount}`;
  $("frame-time").textContent = `t=${displayTime(globalFrame).toFixed(3)}s`;
  $<HTMLInputElement>("timeline").value = String(globalFrame);

  const el = $("event-info");
  if (!current) {
    el.textContent = "—";
    return;
  }
  let label = current.eventType;
  if (current.eventType === "stim") {
    const c = stimFrameCounts.get(current.eventId) ?? -1;
    label = `stim ${current.eventId} (${current.stimFrameIndex + 1}${c > 0 ? "/" + c : ""})`;
  } else if (current.eventType === "attractor") {
    label = `attractor ${current.eventId}`;
  }
  el.innerHTML = `<span class="ev ${current.eventType}">${label}</span>`;
}

function updateMarkerInfo(): void {
  const m = store.get(globalFrame);
  const s = rawSampleAt(globalFrame);
  const raws = s ? `raw(${s.x.toFixed(0)}, ${s.y.toFixed(0)})` : "raw(–)";
  $("marker-current").textContent = m
    ? `${m.isAnchor ? "ANCHOR" : "normal"}  true(${m.trueX.toFixed(0)}, ${m.trueY.toFixed(0)})  ${raws}`
    : `(no marker here)  ${raws}`;
}

// ---------- navigation ----------
function gotoFrame(g: number): void {
  if (globalFrameCount === 0) return;
  globalFrame = Math.max(0, Math.min(globalFrameCount - 1, Math.round(g)));
  showFrame();
  highlightTableRow();
}

function stepStim(dir: number): void {
  const stims = events.filter((e) => e.type === "stim");
  if (!stims.length) return;
  const t = displayTime(globalFrame);
  const target =
    dir > 0
      ? stims.find((s) => s.onset > t + 1e-4)
      : [...stims].reverse().find((s) => s.onset < t - 1e-4);
  if (target) gotoFrame(Math.round(target.onset * fps));
}

function play(): void {
  if (playTimer != null) {
    window.clearInterval(playTimer);
    playTimer = null;
    $("play").textContent = "▶ play";
    return;
  }
  $("play").textContent = "⏸ pause";
  playTimer = window.setInterval(() => {
    if (globalFrame >= globalFrameCount - 1) {
      play();
      return;
    }
    gotoFrame(globalFrame + 1);
  }, 1000 / fps);
}

// ---------- markers ----------
function makeMarker(trueX: number, trueY: number, isAnchor: boolean): Marker {
  const s = rawSampleAt(globalFrame);
  const r = current ?? resolve(globalFrame);
  return {
    globalFrame,
    frameTime: displayTime(globalFrame),
    fps,
    delayMs,
    isAnchor,
    eventType: r ? r.eventType : "",
    eventId: r ? r.eventId : "",
    stimFrameIndex: r ? r.stimFrameIndex : -1,
    rawPosX: s ? s.x : NaN,
    rawPosY: s ? s.y : NaN,
    rawTimestamp: s ? s.t : NaN,
    trueX,
    trueY,
    createdAt: new Date().toISOString(),
    note: "",
  };
}

function placeMarkerAtPixel(px: number, py: number): void {
  const { x, y } = pixelToCoord(clampPixel(px), clampPixel(py));
  const existing = store.get(globalFrame);
  store.put(makeMarker(x, y, existing ? existing.isAnchor : false));
  afterMarkerChange();
}

function addMarkerAtRaw(isAnchor: boolean): void {
  const s = rawSampleAt(globalFrame);
  if (!s) return toast("no raw sample here");
  const { px, py } = rawToPixel(s.x, s.y, pt);
  const { x, y } = pixelToCoord(clampPixel(px), clampPixel(py));
  store.put(makeMarker(x, y, isAnchor));
  afterMarkerChange();
}

function toggleFlag(): void {
  const m = store.get(globalFrame);
  if (!m) return toast("no marker here");
  m.isAnchor = !m.isAnchor;
  store.put(m);
  afterMarkerChange();
}

function deleteMarker(): void {
  if (store.delete(globalFrame)) afterMarkerChange();
}

function nudge(dxPx: number, dyPx: number): void {
  const m = store.get(globalFrame);
  if (!m) return;
  const { px, py } = coordToPixel(m.trueX, m.trueY);
  const { x, y } = pixelToCoord(clampPixel(px + dxPx), clampPixel(py + dyPx));
  m.trueX = x;
  m.trueY = y;
  store.put(m);
  afterMarkerChange();
}

function afterMarkerChange(): void {
  setDirty(true);
  autosave();
  markModelsStale(CALIB_KINDS);
  redraw();
  renderTable();
}

let autosaveTimer: number | null = null;
function autosave(): void {
  if (autosaveTimer != null) window.clearTimeout(autosaveTimer);
  autosaveTimer = window.setTimeout(() => idbSet(`session:${sessionPrefix}`, store.all()), 400);
}

// ---------- table ----------
function renderTable(): void {
  const tbody = $("marker-table").querySelector("tbody")!;
  tbody.innerHTML = "";
  for (const m of store.all()) {
    const tr = document.createElement("tr");
    tr.dataset.g = String(m.globalFrame);
    const ev =
      m.eventType === "stim"
        ? `${m.eventId}#${m.stimFrameIndex}`
        : `${m.eventType} ${m.eventId}`;
    tr.innerHTML =
      `<td>${m.frameTime.toFixed(2)}</td><td>${ev}</td>` +
      `<td><span class="tag ${m.isAnchor ? "anchor" : "normal"}">${m.isAnchor ? "anchor" : "normal"}</span></td>` +
      `<td>${m.trueX.toFixed(0)}</td><td>${m.trueY.toFixed(0)}</td>` +
      `<td>${isNaN(m.rawPosX) ? "–" : m.rawPosX.toFixed(0)}</td>` +
      `<td>${isNaN(m.rawPosY) ? "–" : m.rawPosY.toFixed(0)}</td>` +
      `<td><button class="row-del" title="Delete this marker">✕</button></td>`;
    tr.addEventListener("click", () => gotoFrame(m.globalFrame));
    tr.querySelector(".row-del")!.addEventListener("click", (e) => {
      e.stopPropagation();
      if (store.delete(m.globalFrame)) afterMarkerChange();
    });
    tbody.appendChild(tr);
  }
  highlightTableRow();
}

function highlightTableRow(): void {
  $("marker-table")
    .querySelectorAll("tbody tr")
    .forEach((r) => {
      const el = r as HTMLElement;
      el.classList.toggle("sel", el.dataset.g === String(globalFrame));
    });
}

// ---------- controls ----------
function applyCfgToInputs(): void {
  $<HTMLInputElement>("fps-input").value = String(fps);
  $<HTMLInputElement>("delay-input").value = String(delayMs);
  $<HTMLInputElement>("pt-sx").value = String(pt.sx);
  $<HTMLInputElement>("pt-sy").value = String(pt.sy);
  $<HTMLInputElement>("pt-ox").value = String(pt.ox);
  $<HTMLInputElement>("pt-oy").value = String(pt.oy);
  $<HTMLInputElement>("pt-flipy").checked = pt.flipY;
  $<HTMLInputElement>("tr-input").value = String(tr);
}

function saveCfg(): void {
  if (sessionPrefix) idbSet(`cfg:${sessionPrefix}`, { fps, delayMs, pt, tr, visible: [...visible] });
}

function wireControls(): void {
  $<HTMLSelectElement>("stim-select").addEventListener("change", (e) => {
    const v = (e.target as HTMLSelectElement).value;
    if (v === "") return;
    const ev = events[+v];
    if (ev) gotoFrame(Math.round(ev.onset * fps));
  });

  $("first").addEventListener("click", () => gotoFrame(0));
  $("prev10").addEventListener("click", () => gotoFrame(globalFrame - 10));
  $("prev").addEventListener("click", () => gotoFrame(globalFrame - 1));
  $("next").addEventListener("click", () => gotoFrame(globalFrame + 1));
  $("next10").addEventListener("click", () => gotoFrame(globalFrame + 10));
  $("last").addEventListener("click", () => gotoFrame(globalFrameCount - 1));
  $("play").addEventListener("click", play);
  $<HTMLInputElement>("timeline").addEventListener("input", (e) =>
    gotoFrame(+(e.target as HTMLInputElement).value)
  );

  $("fps-input").addEventListener("change", (e) => {
    const t = displayTime(globalFrame);
    fps = Math.max(1, parseInt((e.target as HTMLInputElement).value) || 30);
    recomputeTimeline();
    saveCfg();
    gotoFrame(Math.round(t * fps)); // keep time position
  });

  const delayInput = $<HTMLInputElement>("delay-input");
  delayInput.addEventListener("change", () => {
    delayMs = parseFloat(delayInput.value) || 0;
    saveCfg();
    redraw();
  });
  $("delay-step").addEventListener("change", (e) => {
    delayStep = parseFloat((e.target as HTMLInputElement).value) || 10;
  });
  $("delay-dec").addEventListener("click", () => changeDelay(-delayStep));
  $("delay-inc").addEventListener("click", () => changeDelay(delayStep));

  for (const k of ["pt-sx", "pt-sy", "pt-ox", "pt-oy", "pt-flipy"]) {
    $(k).addEventListener("change", () => {
      pt = {
        sx: parseFloat($<HTMLInputElement>("pt-sx").value) || 0,
        sy: parseFloat($<HTMLInputElement>("pt-sy").value) || 0,
        ox: parseFloat($<HTMLInputElement>("pt-ox").value) || 0,
        oy: parseFloat($<HTMLInputElement>("pt-oy").value) || 0,
        flipY: $<HTMLInputElement>("pt-flipy").checked,
      };
      saveCfg();
      redraw();
    });
  }

  $("btn-add-normal").addEventListener("click", () => addMarkerAtRaw(false));
  $("btn-add-anchor").addEventListener("click", () => addMarkerAtRaw(true));
  $("btn-toggle").addEventListener("click", toggleFlag);
  $("btn-del").addEventListener("click", deleteMarker);
  $("btn-save").addEventListener("click", saveCsv);
  $("btn-export-dl").addEventListener("click", downloadCsv);

  $("frame-canvas").addEventListener("click", (e) => {
    const { px, py } = renderer.clientToImage((e as MouseEvent).clientX, (e as MouseEvent).clientY);
    placeMarkerAtPixel(px, py);
  });

  $<HTMLInputElement>("motion-file").addEventListener("change", onMotionFile);
  $<HTMLInputElement>("tr-input").addEventListener("change", (e) => {
    tr = Math.max(0.01, parseFloat((e.target as HTMLInputElement).value) || 1);
    saveCfg();
    markModelsStale(["mocet", "mocet_censored"]);
    redraw();
  });
  $("calib-run-all").addEventListener("click", () => CALIB_KINDS.forEach((k) => runCalib(k, true)));
}

// ---------- calibration ----------
async function onMotionFile(e: Event): Promise<void> {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  motion = parseMotion(await f.text());
  motionName = f.name;
  if (sessionPrefix) idbSet(`motion:${sessionPrefix}`, { name: motionName, data: motion });
  markModelsStale(["mocet", "mocet_censored"]);
  updateMotionInfo();
  renderCalibList();
  redraw();
  toast(`motion: ${motion.n} vols, ${fdCount(motion)} FD-flagged`);
}

function updateMotionInfo(): void {
  const el = $("motion-info");
  if (!motion) {
    el.textContent = "no motion file";
    return;
  }
  const fd = motion.fd ? `, ${fdCount(motion)} FD-flagged` : ", no FD column";
  el.textContent = `${motionName} · ${motion.n} vols${fd}`;
}

function runCalib(kind: CalibKind, quiet = false): void {
  const anchors = store.all().filter((m) => m.isAnchor);
  const val = store.all().filter((m) => !m.isAnchor);
  let res: FitResult;
  if (kind === "affine") res = fitAffine(anchors, val);
  else if (kind === "poly2") res = fitPoly2(anchors, val);
  else {
    if (!motion) return quiet ? undefined : void toast("upload a motion file first");
    if (!raw) return;
    res = fitMoCET({
      raw,
      motion,
      tr,
      polyOrder: MOCET_POLY_ORDER,
      censor: kind === "mocet_censored",
      anchors,
      valMarkers: val,
    });
  }
  if ("error" in res) {
    if (!quiet) toast(res.error);
    return;
  }
  models.set(kind, res);
  visible.add(kind);
  persistModels();
  saveCfg();
  renderCalibList();
  redraw();
  if (!quiet) toast(`${CALIB_META[kind].label}: RMSE ${res.rmseTrain.toFixed(0)} (n=${res.nAnchors})`);
}

function markModelsStale(kinds: CalibKind[]): void {
  let changed = false;
  for (const k of kinds) {
    const m = models.get(k);
    if (m && !m.stale) {
      m.stale = true;
      changed = true;
    }
  }
  if (changed) {
    persistModels();
    renderCalibList();
  }
}

function persistModels(): void {
  if (sessionPrefix) idbSet(`calib:${sessionPrefix}`, [...models.values()]);
}

async function loadCalibration(prefix: string): Promise<void> {
  models.clear();
  motion = null;
  motionName = "";
  // A manually-uploaded motion file (cached) overrides the auto-match.
  const mo = await idbGet<{ name: string; data: MotionData }>(`motion:${prefix}`);
  if (mo?.data) {
    motion = mo.data;
    motionName = mo.name;
  } else {
    await autoMatchMotion(prefix);
  }
  const saved = (await idbGet<CalibrationModel[]>(`calib:${prefix}`)) ?? [];
  for (const m of saved) models.set(m.kind, m);
  updateMotionInfo();
  renderCalibList();
}

/** Load `<prefix>_fwd.txt` from the motion folder, if present. */
async function autoMatchMotion(prefix: string): Promise<void> {
  if (!motionDir) return;
  if (!(await ensurePermission(motionDir, "read"))) return;
  const name = `${prefix}_fwd.txt`;
  if (!(await fileExists(motionDir, name))) return;
  motion = parseMotion(await readTextFile(motionDir, name));
  motionName = name;
}

function calibStatusText(kind: CalibKind, model: CalibrationModel | undefined): string {
  if (!model) return CALIB_META[kind].needsMotion && !motion ? "needs motion file" : "not run";
  const v = model.rmseVal != null ? ` · val ${model.rmseVal.toFixed(0)}` : "";
  const stale = model.stale ? `<span class="stale">⚠ stale</span> · ` : "";
  return `${stale}RMSE ${model.rmseTrain.toFixed(0)}${v} · n=${model.nAnchors}`;
}

function renderCalibList(): void {
  const host = $("calib-list");
  host.innerHTML = "";
  for (const kind of CALIB_KINDS) {
    const meta = CALIB_META[kind];
    const model = models.get(kind);
    const row = document.createElement("div");
    row.className = "calib-row";
    row.innerHTML =
      `<label class="calib-show"><input type="checkbox" ${visible.has(kind) ? "checked" : ""} ${
        model ? "" : "disabled"
      } /><span class="swatch" style="background:${meta.color}"></span>${meta.label}</label>` +
      `<span class="calib-status">${calibStatusText(kind, model)}</span>` +
      `<button class="btn sm calib-run">${model ? "Refit" : "Run"}</button>`;
    row.querySelector<HTMLInputElement>("input")!.addEventListener("change", (e) => {
      if ((e.target as HTMLInputElement).checked) visible.add(kind);
      else visible.delete(kind);
      saveCfg();
      redraw();
    });
    row.querySelector(".calib-run")!.addEventListener("click", () => runCalib(kind));
    host.appendChild(row);
  }
}

function changeDelay(d: number): void {
  delayMs += d;
  $<HTMLInputElement>("delay-input").value = String(delayMs);
  saveCfg();
  redraw();
}

// ---------- keyboard ----------
function wireShortcuts(): void {
  window.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      saveCsv();
      return;
    }
    const tag = (document.activeElement as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;

    const ctrl = e.ctrlKey || e.metaKey;
    switch (e.key) {
      case "ArrowLeft":
        e.preventDefault();
        if (ctrl) nudge(e.shiftKey ? -10 : -1, 0);
        else gotoFrame(globalFrame - (e.shiftKey ? 10 : 1));
        break;
      case "ArrowRight":
        e.preventDefault();
        if (ctrl) nudge(e.shiftKey ? 10 : 1, 0);
        else gotoFrame(globalFrame + (e.shiftKey ? 10 : 1));
        break;
      case "ArrowUp":
        if (ctrl) {
          e.preventDefault();
          nudge(0, e.shiftKey ? -10 : -1);
        }
        break;
      case "ArrowDown":
        if (ctrl) {
          e.preventDefault();
          nudge(0, e.shiftKey ? 10 : 1);
        }
        break;
      case "[":
        stepStim(-1);
        break;
      case "]":
        stepStim(1);
        break;
      case " ":
        e.preventDefault();
        play();
        break;
      case "Home":
        gotoFrame(0);
        break;
      case "End":
        gotoFrame(globalFrameCount - 1);
        break;
      case "a":
        addMarkerAtRaw(false);
        break;
      case "A":
        addMarkerAtRaw(true);
        break;
      case "t":
      case "T":
        toggleFlag();
        break;
      case "Delete":
      case "Backspace":
        e.preventDefault();
        deleteMarker();
        break;
      case ",":
        changeDelay(-delayStep);
        break;
      case ".":
        changeDelay(delayStep);
        break;
    }
  });
}

// ---------- save ----------
async function saveCsv(): Promise<void> {
  if (!sharedDir || !sessionPrefix) return;
  await writeTextFile(sharedDir, `${sessionPrefix}_calibration_anchors.csv`, markersToCsv(store.all()));
  setDirty(false);
  toast(`saved ${store.size} markers → ${sessionPrefix}_calibration_anchors.csv`);
}

function downloadCsv(): void {
  const blob = new Blob([markersToCsv(store.all())], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${sessionPrefix}_calibration_anchors.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

init();
