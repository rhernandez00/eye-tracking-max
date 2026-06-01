import "./style.css";
import {
  pickStimuliDir,
  pickSharedDir,
  restoreStimuliDir,
  restoreSharedDir,
  ensurePermission,
  readTextFile,
  writeTextFile,
  fileExists,
  listFiles,
  listDirs,
  countFrames,
  loadFrame,
  DirHandle,
} from "./fsaccess";
import { parseRawEyetrack, nearestSample, parseStimSegments } from "./csv";
import { MarkerStore, markersToCsv, markersFromCsv } from "./markers";
import { Renderer } from "./render";
import { pixelToCoord, coordToPixel, rawToPixel, clampPixel } from "./coords";
import { idbGet, idbSet } from "./idb";
import { Marker, PreviewTransform, RawEyetrack, StimSegment } from "./types";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const EYETRACK_SUFFIXES = ["_raw_eyetrack.csv", "_eyetrack_rough_calibration.csv"];
const EYETRACK_RE = /_(raw_eyetrack|eyetrack_rough_calibration)\.csv$/;

// ---------- state ----------
let stimuliDir: DirHandle | null = null;
let sharedDir: DirHandle | null = null;

let sessionPrefix = "";
let raw: RawEyetrack | null = null;
let segments: StimSegment[] = []; // from full_log, when available
let folderMode = false; // true when no full_log: stim-select lists folders

const store = new MarkerStore();
let pt: PreviewTransform = { sx: 1, sy: 1, ox: 0, oy: 0, flipY: false };
let fps = 30;
let delayMs = 0;
let delayStep = 10;

let stimId = "";
let onset = 0;
let frameCount = 0;
let frameIndex = 0;

let renderer: Renderer;
let frameToken = 0;
const bmpCache = new Map<string, ImageBitmap>();
let playTimer: number | null = null;

// ---------- helpers ----------
function frameTimeOf(idx: number): number {
  return onset + idx / fps + delayMs / 1000;
}

function currentRawSample(): { x: number; y: number; t: number } | null {
  if (!raw || raw.n === 0) return null;
  const i = nearestSample(raw, frameTimeOf(frameIndex));
  if (i < 0) return null;
  return { x: raw.x[i], y: raw.y[i], t: raw.t[i] };
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

// ---------- setup / folder access ----------
async function init(): Promise<void> {
  renderer = new Renderer($("frame-canvas") as HTMLCanvasElement);
  wireSetup();
  wireControls();
  wireShortcuts();

  // try to restore previously-granted folders
  stimuliDir = await restoreStimuliDir();
  sharedDir = await restoreSharedDir();
  if (stimuliDir) $("pick-stimuli").textContent = `📁 ${stimuliDir.name} ✓`;
  if (sharedDir) $("pick-shared").textContent = `📁 ${sharedDir.name} ✓`;
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
  // A session's eyetrack file is either _raw_eyetrack.csv or _eyetrack_rough_calibration.csv.
  const sessions = [
    ...new Set(
      files
        .filter((f) => EYETRACK_SUFFIXES.some((s) => f.endsWith(s)))
        .map((f) => f.replace(EYETRACK_RE, ""))
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

  $("setup-status").textContent = "loading…";
  sessionPrefix = prefix;

  // eyetrack samples — _raw_eyetrack.csv or _eyetrack_rough_calibration.csv
  let eyetrackName = "";
  for (const s of EYETRACK_SUFFIXES) {
    if (await fileExists(sharedDir, `${prefix}${s}`)) {
      eyetrackName = `${prefix}${s}`;
      break;
    }
  }
  if (!eyetrackName) {
    $("setup-status").textContent = "no eyetrack file for session";
    return toast("no eyetrack csv found");
  }
  raw = parseRawEyetrack(await readTextFile(sharedDir, eyetrackName));

  // optional full_log -> stim segments
  segments = [];
  folderMode = false;
  if (await fileExists(sharedDir, `${prefix}_full_log.csv`)) {
    segments = parseStimSegments(await readTextFile(sharedDir, `${prefix}_full_log.csv`));
  }
  if (segments.length === 0) {
    folderMode = true;
    if (!(await ensurePermission(stimuliDir, "read"))) return toast("need stimuli permission");
  }

  // restore per-session config
  const cfg = await idbGet<any>(`cfg:${prefix}`);
  if (cfg) {
    fps = cfg.fps ?? 30;
    delayMs = cfg.delayMs ?? 0;
    pt = cfg.pt ?? pt;
  }
  applyCfgToInputs();

  // load markers: prefer existing CSV, else autosave
  await loadMarkers(prefix);

  await populateStimSelect();
  $("workspace").classList.remove("hidden");
  $("setup-status").textContent = `loaded ${prefix} (${raw.n} samples)`;

  await selectStimByUi();
}

async function loadMarkers(prefix: string): Promise<void> {
  const outName = `${prefix}_calibration_anchors.csv`;
  if (await fileExists(sharedDir!, outName)) {
    store.load(markersFromCsv(await readTextFile(sharedDir!, outName)));
  } else {
    const saved = await idbGet<Marker[]>(`session:${prefix}`);
    store.load(saved ?? []);
  }
  setDirty(false);
}

async function populateStimSelect(): Promise<void> {
  const sel = $<HTMLSelectElement>("stim-select");
  sel.innerHTML = "";
  if (folderMode) {
    const dirs = await listDirs(stimuliDir!);
    for (const d of dirs) {
      const o = document.createElement("option");
      o.value = d;
      o.textContent = d;
      sel.appendChild(o);
    }
  } else {
    for (const s of segments) {
      const o = document.createElement("option");
      o.value = String(s.index);
      o.textContent = `#${s.index + 1}  ${s.id}  @${s.onset.toFixed(2)}s`;
      sel.appendChild(o);
    }
  }
}

async function selectStimByUi(): Promise<void> {
  const sel = $<HTMLSelectElement>("stim-select");
  if (folderMode) {
    stimId = sel.value || "";
    onset = parseFloat($<HTMLInputElement>("onset-input").value) || 0;
  } else {
    const seg = segments[+sel.value] ?? segments[0];
    stimId = seg.id;
    onset = seg.onset;
    $<HTMLInputElement>("onset-input").value = onset.toFixed(3);
  }
  frameCount = stimId ? await countFrames(stimuliDir!, stimId) : 0;
  if (frameCount < 0) {
    toast(`frames folder "${stimId}" not found`);
    frameCount = 0;
  }
  frameIndex = 0;
  bmpCache.clear();
  $("stim-meta").textContent = stimId ? `${frameCount} frames` : "no stim";
  await showFrame();
  renderTable();
}

// ---------- frame display ----------
async function getBitmap(idx: number): Promise<ImageBitmap | null> {
  if (!stimId || idx < 0 || idx >= frameCount) return null;
  const key = `${stimId}#${idx}`;
  const hit = bmpCache.get(key);
  if (hit) return hit;
  try {
    const bmp = await loadFrame(stimuliDir!, stimId, idx);
    bmpCache.set(key, bmp);
    if (bmpCache.size > 60) {
      const first = bmpCache.keys().next().value as string;
      bmpCache.delete(first);
    }
    return bmp;
  } catch {
    return null;
  }
}

async function showFrame(): Promise<void> {
  const token = ++frameToken;
  const bmp = await getBitmap(frameIndex);
  if (token !== frameToken) return; // superseded
  renderer.setFrame(bmp);
  redraw();
  updateFrameInfo();
  getBitmap(frameIndex + 1); // prefetch
}

function redraw(): void {
  const s = currentRawSample();
  renderer.draw({
    rawX: s ? s.x : null,
    rawY: s ? s.y : null,
    pt,
    marker: store.get(stimId, frameIndex) ?? null,
  });
  updateMarkerInfo();
}

function updateFrameInfo(): void {
  $("frame-info").textContent = `${frameCount ? frameIndex + 1 : 0} / ${frameCount}`;
  $("frame-time").textContent = `t=${frameTimeOf(frameIndex).toFixed(3)}s`;
}

function updateMarkerInfo(): void {
  const m = store.get(stimId, frameIndex);
  const s = currentRawSample();
  const raws = s ? `raw(${s.x.toFixed(0)}, ${s.y.toFixed(0)})` : "raw(–)";
  $("marker-current").textContent = m
    ? `${m.isAnchor ? "ANCHOR" : "normal"}  true(${m.trueX.toFixed(0)}, ${m.trueY.toFixed(0)})  ${raws}`
    : `(no marker on this frame)  ${raws}`;
}

// ---------- navigation ----------
function gotoFrame(idx: number): void {
  if (frameCount === 0) return;
  frameIndex = Math.max(0, Math.min(frameCount - 1, idx));
  showFrame();
  highlightTableRow();
}

function stepStim(d: number): void {
  const sel = $<HTMLSelectElement>("stim-select");
  const n = sel.options.length;
  if (!n) return;
  sel.selectedIndex = Math.max(0, Math.min(n - 1, sel.selectedIndex + d));
  selectStimByUi();
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
    if (frameIndex >= frameCount - 1) {
      play(); // stop at end
      return;
    }
    gotoFrame(frameIndex + 1);
  }, 1000 / fps);
}

// ---------- markers ----------
function makeMarker(trueX: number, trueY: number, isAnchor: boolean): Marker {
  const s = currentRawSample();
  return {
    stimId,
    frameIndex,
    frameTime: frameTimeOf(frameIndex),
    fps,
    delayMs,
    isAnchor,
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
  const existing = store.get(stimId, frameIndex);
  store.put(makeMarkerKeepType(x, y, existing));
  afterMarkerChange();
}

function makeMarkerKeepType(x: number, y: number, existing?: Marker): Marker {
  return makeMarker(x, y, existing ? existing.isAnchor : false);
}

/** Add/replace marker at the current raw-eye preview position. */
function addMarkerAtRaw(isAnchor: boolean): void {
  const s = currentRawSample();
  if (!s) return toast("no raw sample at this time");
  const { px, py } = rawToPixel(s.x, s.y, pt);
  const { x, y } = pixelToCoord(clampPixel(px), clampPixel(py));
  store.put(makeMarker(x, y, isAnchor));
  afterMarkerChange();
}

function toggleFlag(): void {
  const m = store.get(stimId, frameIndex);
  if (!m) return toast("no marker on this frame");
  m.isAnchor = !m.isAnchor;
  store.put(m);
  afterMarkerChange();
}

function deleteMarker(): void {
  if (store.delete(stimId, frameIndex)) afterMarkerChange();
}

function nudge(dxPx: number, dyPx: number): void {
  const m = store.get(stimId, frameIndex);
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
  redraw();
  renderTable();
}

let autosaveTimer: number | null = null;
function autosave(): void {
  if (autosaveTimer != null) window.clearTimeout(autosaveTimer);
  autosaveTimer = window.setTimeout(() => {
    idbSet(`session:${sessionPrefix}`, store.all());
  }, 400);
}

// ---------- table ----------
function renderTable(): void {
  const tbody = $("marker-table").querySelector("tbody")!;
  tbody.innerHTML = "";
  for (const m of store.all()) {
    const tr = document.createElement("tr");
    tr.dataset.stim = m.stimId;
    tr.dataset.frame = String(m.frameIndex);
    tr.innerHTML =
      `<td>${m.stimId}</td><td>${m.frameIndex}</td>` +
      `<td><span class="tag ${m.isAnchor ? "anchor" : "normal"}">${m.isAnchor ? "anchor" : "normal"}</span></td>` +
      `<td>${m.trueX.toFixed(0)}</td><td>${m.trueY.toFixed(0)}</td>` +
      `<td>${isNaN(m.rawPosX) ? "–" : m.rawPosX.toFixed(0)}</td>` +
      `<td>${isNaN(m.rawPosY) ? "–" : m.rawPosY.toFixed(0)}</td>`;
    tr.addEventListener("click", () => jumpToMarker(m.stimId, m.frameIndex));
    tbody.appendChild(tr);
  }
  highlightTableRow();
}

function highlightTableRow(): void {
  const rows = $("marker-table").querySelectorAll("tbody tr");
  rows.forEach((r) => {
    const el = r as HTMLElement;
    el.classList.toggle(
      "sel",
      el.dataset.stim === stimId && el.dataset.frame === String(frameIndex)
    );
  });
}

async function jumpToMarker(mStim: string, mFrame: number): Promise<void> {
  const sel = $<HTMLSelectElement>("stim-select");
  if (mStim !== stimId) {
    if (folderMode) sel.value = mStim;
    else {
      const seg = segments.find((s) => s.id === mStim);
      if (seg) sel.value = String(seg.index);
    }
    await selectStimByUi();
  }
  gotoFrame(mFrame);
}

// ---------- controls wiring ----------
function applyCfgToInputs(): void {
  $<HTMLInputElement>("fps-input").value = String(fps);
  $<HTMLInputElement>("delay-input").value = String(delayMs);
  $<HTMLInputElement>("pt-sx").value = String(pt.sx);
  $<HTMLInputElement>("pt-sy").value = String(pt.sy);
  $<HTMLInputElement>("pt-ox").value = String(pt.ox);
  $<HTMLInputElement>("pt-oy").value = String(pt.oy);
  $<HTMLInputElement>("pt-flipy").checked = pt.flipY;
}

function saveCfg(): void {
  if (sessionPrefix) idbSet(`cfg:${sessionPrefix}`, { fps, delayMs, pt });
}

function wireControls(): void {
  $("stim-select").addEventListener("change", () => selectStimByUi());
  $("onset-input").addEventListener("change", () => {
    if (folderMode) {
      onset = parseFloat($<HTMLInputElement>("onset-input").value) || 0;
      redraw();
      updateFrameInfo();
    }
  });

  $("first").addEventListener("click", () => gotoFrame(0));
  $("prev10").addEventListener("click", () => gotoFrame(frameIndex - 10));
  $("prev").addEventListener("click", () => gotoFrame(frameIndex - 1));
  $("next").addEventListener("click", () => gotoFrame(frameIndex + 1));
  $("next10").addEventListener("click", () => gotoFrame(frameIndex + 10));
  $("last").addEventListener("click", () => gotoFrame(frameCount - 1));
  $("play").addEventListener("click", play);

  $("fps-input").addEventListener("change", (e) => {
    fps = Math.max(1, parseInt((e.target as HTMLInputElement).value) || 30);
    saveCfg();
    redraw();
    updateFrameInfo();
  });

  const delayInput = $<HTMLInputElement>("delay-input");
  delayInput.addEventListener("change", () => {
    delayMs = parseFloat(delayInput.value) || 0;
    saveCfg();
    redraw();
    updateFrameInfo();
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

  // marker buttons
  $("btn-add-normal").addEventListener("click", () => addMarkerAtRaw(false));
  $("btn-add-anchor").addEventListener("click", () => addMarkerAtRaw(true));
  $("btn-toggle").addEventListener("click", toggleFlag);
  $("btn-del").addEventListener("click", deleteMarker);
  $("btn-save").addEventListener("click", saveCsv);
  $("btn-export-dl").addEventListener("click", downloadCsv);

  // click on canvas = place/move marker (keeps type)
  $("frame-canvas").addEventListener("click", (e) => {
    const { px, py } = renderer.clientToImage((e as MouseEvent).clientX, (e as MouseEvent).clientY);
    placeMarkerAtPixel(px, py);
  });
}

function changeDelay(d: number): void {
  delayMs += d;
  $<HTMLInputElement>("delay-input").value = String(delayMs);
  saveCfg();
  redraw();
  updateFrameInfo();
}

// ---------- keyboard ----------
function wireShortcuts(): void {
  window.addEventListener("keydown", (e) => {
    // Ctrl+S works everywhere
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
        else gotoFrame(frameIndex - (e.shiftKey ? 10 : 1));
        break;
      case "ArrowRight":
        e.preventDefault();
        if (ctrl) nudge(e.shiftKey ? 10 : 1, 0);
        else gotoFrame(frameIndex + (e.shiftKey ? 10 : 1));
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
        gotoFrame(frameCount - 1);
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
  const csv = markersToCsv(store.all());
  await writeTextFile(sharedDir, `${sessionPrefix}_calibration_anchors.csv`, csv);
  setDirty(false);
  toast(`saved ${store.size} markers → ${sessionPrefix}_calibration_anchors.csv`);
}

function downloadCsv(): void {
  const csv = markersToCsv(store.all());
  const blob = new Blob([csv], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${sessionPrefix}_calibration_anchors.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

init();
