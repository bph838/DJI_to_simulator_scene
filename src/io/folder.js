// Reading the photo folder and writing the scene, via the File System Access API (Chrome/Edge).

export const canUseFolders = () => typeof window.showDirectoryPicker === "function";

export async function pickPhotoFolder() {
  const dir = await window.showDirectoryPicker({ id: "photos", mode: "read" });
  const files = [];
  for await (const entry of dir.values()) {
    if (entry.kind === "file" && /\.jpe?g$/i.test(entry.name)) files.push(await entry.getFile());
  }
  files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return { name: dir.name, files };
}

export async function pickOutputFolder() {
  return window.showDirectoryPicker({ id: "output", mode: "readwrite" });
}

export async function ensureWritable(dir) {
  const opts = { mode: "readwrite" };
  if ((await dir.queryPermission(opts)) === "granted") return true;
  return (await dir.requestPermission(opts)) === "granted";
}

export async function subdir(dir, ...names) {
  for (const n of names) dir = await dir.getDirectoryHandle(n, { create: true });
  return dir;
}

export async function writeFile(dir, name, blob) {
  const handle = await dir.getFileHandle(name, { create: true });
  const w = await handle.createWritable();
  await w.write(blob);
  await w.close();
}

export async function readTextIfExists(dir, name) {
  try {
    const handle = await dir.getFileHandle(name);
    return await (await handle.getFile()).text();
  } catch (e) {
    if (e.name === "NotFoundError") return null;
    throw e;
  }
}

export async function listNames(dir) {
  const names = [];
  for await (const entry of dir.values()) names.push(entry.name);
  return names;
}

export async function tryGetDir(dir, name) {
  try {
    return await dir.getDirectoryHandle(name);
  } catch (e) {
    if (e.name === "NotFoundError" || e.name === "TypeMismatchError") return null;
    throw e;
  }
}
