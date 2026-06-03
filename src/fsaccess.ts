import { idbGet, idbSet } from "./idb";

// Own minimal typings for the File System Access API (Chromium), independent of
// whatever the TS DOM lib ships — avoids cross-version declaration conflicts.
export interface FileHandle {
  kind: "file";
  name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(d: string | BufferSource | Blob): Promise<void>; close(): Promise<void> }>;
}
export interface DirHandle {
  kind: "directory";
  name: string;
  values(): AsyncIterableIterator<{ kind: "file" | "directory"; name: string }>;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FileHandle>;
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<DirHandle>;
  queryPermission(d?: { mode?: "read" | "readwrite" }): Promise<"granted" | "denied" | "prompt">;
  requestPermission(d?: { mode?: "read" | "readwrite" }): Promise<"granted" | "denied" | "prompt">;
}

const picker = (opts: { id?: string; mode?: "read" | "readwrite" }): Promise<DirHandle> =>
  (window as any).showDirectoryPicker(opts);

const KEY_STIMULI = "dir:stimuli";
const KEY_SHARED = "dir:shared";

export async function pickStimuliDir(): Promise<DirHandle> {
  const h = await picker({ id: "stimuli", mode: "read" });
  await idbSet(KEY_STIMULI, h);
  return h;
}

export async function pickSharedDir(): Promise<DirHandle> {
  const h = await picker({ id: "shared", mode: "readwrite" });
  await idbSet(KEY_SHARED, h);
  return h;
}

async function restore(key: string): Promise<DirHandle | null> {
  return (await idbGet<DirHandle>(key)) ?? null;
}

export const restoreStimuliDir = () => restore(KEY_STIMULI);
export const restoreSharedDir = () => restore(KEY_SHARED);

export async function ensurePermission(h: DirHandle, mode: "read" | "readwrite"): Promise<boolean> {
  if ((await h.queryPermission({ mode })) === "granted") return true;
  return (await h.requestPermission({ mode })) === "granted";
}

// ---- file helpers ----

export async function readTextFile(dir: DirHandle, name: string): Promise<string> {
  const fh = await dir.getFileHandle(name);
  return (await fh.getFile()).text();
}

export async function fileExists(dir: DirHandle, name: string): Promise<boolean> {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}

export async function writeTextFile(dir: DirHandle, name: string, text: string): Promise<void> {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(text);
  await w.close();
}

export async function listFiles(dir: DirHandle): Promise<string[]> {
  const out: string[] = [];
  for await (const e of dir.values()) if (e.kind === "file") out.push(e.name);
  return out;
}

/** List immediate sub-directory names (stim folder candidates). */
export async function listDirs(dir: DirHandle): Promise<string[]> {
  const out: string[] = [];
  for await (const e of dir.values()) if (e.kind === "directory") out.push(e.name);
  out.sort();
  return out;
}

/** Count frame_####.jpg files in a stim folder; -1 if the folder is missing. */
export async function countFrames(stimuliDir: DirHandle, stimId: string): Promise<number> {
  let folder: DirHandle;
  try {
    folder = await stimuliDir.getDirectoryHandle(stimId);
  } catch {
    return -1;
  }
  let n = 0;
  for await (const e of folder.values()) {
    if (e.kind === "file" && /^frame_\d+\.jpg$/i.test(e.name)) n++;
  }
  return n;
}

/** Load an image (any file in a sub-folder of stimuli) as a bitmap. */
export async function loadImageFile(
  stimuliDir: DirHandle,
  folderName: string,
  fileName: string
): Promise<ImageBitmap> {
  const folder = await stimuliDir.getDirectoryHandle(folderName);
  const fh = await folder.getFileHandle(fileName);
  return createImageBitmap(await fh.getFile());
}
