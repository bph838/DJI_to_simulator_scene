import { FACE_NAMES, dirToLonLat, sceneAxes } from "./core/geometry.js";
import { buildCameras, loadFrames, summarise } from "./core/scene.js";
import { fillHoles } from "./core/fill.js";
import { createGL } from "./render/gl.js";
import { Stitcher, TextureCache } from "./render/stitcher.js";
import { Viewer } from "./render/viewer.js";
import { drawPanoMap, lonAt } from "./ui/panoMap.js";
import { canUseFolders, ensureWritable, pickOutputFolder, pickPhotoFolder } from "./io/folder.js";
import { exportScene } from "./export/exporter.js";

const $ = (id) => document.getElementById(id);
const PREVIEW_FACE = 512;
const PREVIEW_PANO = 1600;

$("app-version").textContent = `v${__APP_VERSION__}` + (__APP_COMMIT__ ? ` · ${__APP_COMMIT__}` : "");
$("app-version").title = "Version · build commit";

const state = {
  frames: [],
  summary: null,
  sourceName: "",
  heading: 0,
  outDir: null,
  busy: false,
  previewTextures: null,
};

let gl, stitcher, viewer;
try {
  gl = createGL($("viewer"));
  stitcher = new Stitcher(gl);
  viewer = new Viewer(gl, $("viewer"));
} catch (e) {
  $("unsupported").hidden = false;
  $("unsupported").textContent = e.message;
}
if (!window.isSecureContext) {
  // Chrome only offers folder access on https:// (or localhost) pages.
  $("unsupported").hidden = false;
  $("unsupported").innerHTML =
    `This page was opened over plain http, so the browser won't allow folder access. ` +
    `<a href="https://${location.host}${location.pathname}">Open the secure https:// version</a>.`;
} else if (!canUseFolders()) {
  $("unsupported").hidden = false;
}

// --- Settings ------------------------------------------------------------------

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem("sceneMaker." + key);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem("sceneMaker." + key, JSON.stringify(value));
    } catch {
      /* storage unavailable: settings just won't be remembered */
    }
  },
};

function viewSettings() {
  return {
    exposure: $("exposure").checked,
    fillGaps: $("fill-gaps").checked,
    feather: Number($("feather").value),
  };
}

function exportSettings() {
  return {
    ...viewSettings(),
    frontHeading: state.heading,
    sizes: [...document.querySelectorAll('input[name="size"]:checked')].map((i) => Number(i.value)),
    format: document.querySelector('input[name="format"]:checked').value,
    jpegQuality: Number($("jpeg-quality").value) / 100,
    writeXml: $("write-xml").checked,
    equirect: $("write-equirect").checked,
    author: $("author").value.trim(),
    droneModel: state.summary?.model,
  };
}

export function sceneName() {
  return $("scene-name").value.trim().replace(/[\\/:*?"<>|]+/g, "").replace(/\s+/g, "_");
}

// --- Step 1: photos ---------------------------------------------------------------

$("pick-photos").addEventListener("click", async () => {
  let picked;
  try {
    picked = await pickPhotoFolder();
  } catch (e) {
    if (e.name !== "AbortError") alert(e.message);
    return;
  }
  await loadFiles(picked.name, picked.files);
});

async function loadFiles(name, files) {
  if (!files.length) {
    $("photos-status").textContent = `No JPG files in "${name}".`;
    return;
  }
  state.sourceName = name;
  $("photos-status").textContent = `Reading ${files.length} photos…`;
  const bar = $("load-progress");
  bar.hidden = false;
  for (const f of state.frames) f.thumb?.close();
  state.previewTextures?.clear();

  const { frames, skipped } = await loadFrames(files, (p) => (bar.firstElementChild.style.width = `${p * 100}%`));
  bar.hidden = true;
  state.frames = frames;
  if (!frames.length) {
    $("photos-status").textContent = `None of the ${files.length} photos have DJI gimbal data, so they can't be placed.`;
    return;
  }
  $("photos-status").textContent =
    `${frames.length} photos from "${name}"` + (skipped.length ? ` · ${skipped.length} skipped` : "");
  state.summary = summarise(frames);
  showSummary(state.summary, skipped);
  showFrameTable(frames);

  $("focal35").value = frames[0].meta.focalLength35 ?? 24;
  state.headingKey = `heading.${frames[0].meta.createDate ?? name}`;
  const remembered = store.get(state.headingKey, null);
  setHeading(remembered ?? 0, false);
  $("scene-name").value ||= store.get("sceneName", "") || name.replace(/\s+/g, "_");
  $("author").value ||= store.get("author", "");
  updateXmlName();

  rebuildCameras();
  state.previewTextures = new TextureCache(gl, async (f) => f.thumb, 1 << 30);
  $("step-preview").hidden = false;
  $("step-export").hidden = false;
  await renderPreview();
  if (remembered === null) {
    $("photos-status").textContent += " · now set the front heading";
  }
}

function showSummary(s, skipped) {
  const fmtTime = (t) => (t >= 1 ? `${t}s` : `1/${Math.round(1 / t)}s`);
  const items = [
    ["Drone", s.model ?? "?"],
    ["Photos", `${s.count} × ${s.size}`],
    ["Lens", s.focal35 ? `${s.focal35} mm equivalent` : "unknown (assuming 24 mm)"],
    ["Taken", s.taken ? s.taken.replace("T", " ").slice(0, 19) : "?"],
    ["Position", Number.isFinite(s.latitude) ? `${s.latitude.toFixed(6)}, ${s.longitude.toFixed(6)}` : "?"],
    ["Height", Number.isFinite(s.height) ? `${s.height.toFixed(1)} m above take-off` : "?"],
    ["GPS drift during shoot", Number.isFinite(s.drift) ? `${s.drift.toFixed(1)} m` : "?", s.drift > 1.5],
    ["Shutter", s.exposureRange ? `${fmtTime(s.exposureRange[0])} – ${fmtTime(s.exposureRange[1])}` : "?"],
  ];
  if (s.count !== 35) items.push(["Note", `A DJI sphere pano is normally 35 photos; this folder has ${s.count}.`, true]);
  for (const k of skipped) items.push([`Skipped ${k.name}`, k.reason, true]);
  $("summary-list").innerHTML = items
    .map(([k, v, warn]) => `<div class="${warn ? "warn" : ""}"><dt>${k}</dt><dd>${v}</dd></div>`)
    .join("");
  $("shoot-summary").hidden = false;
}

function showFrameTable(frames) {
  const rows = frames.map((f, i) => {
    const m = f.meta;
    return `<tr><td>${i + 1}. ${f.name}</td><td>${m.gimbalYaw.toFixed(1)}°</td><td>${m.gimbalPitch.toFixed(1)}°</td>
      <td>${(m.gimbalRoll ?? 0).toFixed(1)}°</td><td>${m.exposureTime ? "1/" + Math.round(1 / m.exposureTime) : "?"}</td>
      <td>${f.gain.toFixed(2)}</td><td>${m.relativeAltitude?.toFixed(1) ?? "?"} m</td></tr>`;
  });
  $("frame-table").innerHTML =
    "<tr><th>Photo</th><th>Gimbal yaw</th><th>Pitch</th><th>Roll</th><th>Shutter</th><th>Gain</th><th>Height</th></tr>" +
    rows.join("");
}

function rebuildCameras() {
  buildCameras(state.frames, { focal35: Number($("focal35").value) || undefined, k1: Number($("k1").value) || 0 });
}

// --- Step 2: preview ----------------------------------------------------------------

let previewQueued = false, previewRunning = false;
async function renderPreview() {
  if (!state.frames.length || !stitcher) return;
  if (previewRunning) {
    previewQueued = true;
    return;
  }
  previewRunning = true;
  try {
    do {
      previewQueued = false;
      const axes = sceneAxes(state.heading);
      const settings = viewSettings();
      const args = { frames: state.frames, textures: state.previewTextures, axes, settings };

      const pano = await stitcher.renderEquirect({ ...args, width: PREVIEW_PANO });
      state.lastPano = pano;
      drawMap();

      const faces = {};
      const strip = $("face-strip");
      strip.innerHTML = "";
      for (const face of FACE_NAMES) {
        const img = await stitcher.renderFace({ ...args, face, size: PREVIEW_FACE });
        if (settings.fillGaps) fillHoles(img);
        const c = document.createElement("canvas");
        c.width = c.height = PREVIEW_FACE;
        c.getContext("2d").putImageData(img, 0, 0);
        faces[face] = c;
        const fig = document.createElement("figure");
        fig.append(c);
        fig.insertAdjacentHTML("beforeend", `<figcaption>_${face}</figcaption>`);
        strip.append(fig);
      }
      viewer.setFaces(faces, axes);
    } while (previewQueued);
  } finally {
    previewRunning = false;
  }
}

function drawMap() {
  if (!state.lastPano) return;
  drawPanoMap($("pano-map"), state.lastPano, state.frames, sceneAxes(state.heading), {
    outlines: $("show-outlines").checked,
  });
}

function setHeading(h, render = true) {
  h = ((Number(h) % 360) + 360) % 360;
  state.heading = Math.round(h * 10) / 10;
  $("heading-range").value = state.heading;
  $("heading-num").value = state.heading;
  if (state.headingKey) store.set(state.headingKey, state.heading);
  if (render) renderPreview();
}

$("heading-range").addEventListener("input", (e) => setHeading(e.target.value));
$("heading-num").addEventListener("change", (e) => setHeading(e.target.value));
$("pano-map").addEventListener("click", (e) => {
  setHeading(state.heading + lonAt($("pano-map"), e));
  viewer.lookAt(0, 0);
});
$("use-view").addEventListener("click", () => {
  const yaw = viewer.yaw;
  viewer.lookAt(0);
  setHeading(state.heading + yaw);
});
$("show-outlines").addEventListener("change", drawMap);
$("show-grid").addEventListener("change", (e) => {
  viewer.grid = e.target.checked;
  viewer.draw();
});
for (const id of ["exposure", "fill-gaps", "feather"]) $(id).addEventListener("change", renderPreview);
for (const id of ["focal35", "k1"]) {
  $(id).addEventListener("change", () => {
    rebuildCameras();
    renderPreview();
  });
}
if (viewer) {
  viewer.onView = (yaw, pitch) => {
    const compass = (((state.heading + yaw) % 360) + 360) % 360;
    $("view-dir").textContent = `looking ${compass.toFixed(0)}° (${yaw >= 0 ? "+" : ""}${yaw.toFixed(0)}° from front), ${pitch.toFixed(0)}° up`;
  };
}

// --- Step 3: export -------------------------------------------------------------------

function updateXmlName() {
  $("xml-name").textContent = `${sceneName() || "scene"}.xml`;
  updateOutPath();
}

function updateOutPath() {
  const name = sceneName() || "<scene>";
  $("out-path").textContent = state.outDir ? `${state.outDir.name}/${name}/<size>/${name}_front…` : "choose a folder";
  $("export").disabled = !state.outDir || !state.frames.length || state.busy;
}

$("scene-name").addEventListener("input", updateXmlName);
$("quality-wrap").hidden = false;
for (const r of document.querySelectorAll('input[name="format"]')) {
  r.addEventListener("change", () => ($("quality-wrap").hidden = exportSettings().format !== "jpg"));
}

$("pick-output").addEventListener("click", async () => {
  try {
    state.outDir = await pickOutputFolder();
  } catch (e) {
    if (e.name !== "AbortError") alert(e.message);
    return;
  }
  updateOutPath();
});

$("export").addEventListener("click", async () => {
  const scene = sceneName();
  const settings = exportSettings();
  if (!scene) return alert("Please give the scene a name.");
  if (!settings.sizes.length) return alert("Pick at least one size.");
  if (!(await ensureWritable(state.outDir))) return alert("Permission to write to that folder was refused.");
  store.set("sceneName", $("scene-name").value.trim());
  store.set("author", settings.author);

  state.busy = true;
  updateOutPath();
  const log = $("log");
  log.hidden = false;
  log.textContent = "";
  const write = (line) => {
    log.textContent += line + "\n";
    log.scrollTop = log.scrollHeight;
  };
  const bar = $("export-progress");
  bar.hidden = false;
  const t0 = performance.now();
  try {
    write(`Scene "${scene}", front heading ${state.heading}°, ${settings.format.toUpperCase()}, sizes ${settings.sizes.join(", ")}`);
    await exportScene({
      stitcher, frames: state.frames, outDir: state.outDir, scene, settings, log: write,
      progress: (p) => (bar.firstElementChild.style.width = `${p * 100}%`),
    });
    write(`\nDone in ${((performance.now() - t0) / 1000).toFixed(0)} s. Copy the "${scene}" folder into Heli-X's SkyBox folder.`);
  } catch (e) {
    console.error(e);
    write(`\nFailed: ${e.message}`);
  } finally {
    state.busy = false;
    bar.hidden = true;
    updateOutPath();
    // The export used the GPU heavily; refresh the preview textures it may have evicted.
    viewer.draw();
  }
});

// Hook for the automated browser tests.
window.sceneMaker = {
  loadFiles,
  setHeading,
  state,
  async renderFaces(size, heading = state.heading) {
    const axes = sceneAxes(heading);
    const out = {};
    const textures = new TextureCache(gl, (f) => createImageBitmap(f.file), 640 << 20);
    for (const face of FACE_NAMES) {
      const img = await stitcher.renderFace({ frames: state.frames, textures, axes, face, size, settings: viewSettings() });
      const holes = fillHoles(img);
      const c = new OffscreenCanvas(size, size);
      c.getContext("2d").putImageData(img, 0, 0);
      const blob = await c.convertToBlob({ type: "image/jpeg", quality: 0.9 });
      out[face] = { holes, jpeg: await blobToBase64(blob) };
    }
    textures.clear();
    stitcher.disposeTargets();
    return out;
  },
  lonLatOfFrame: (i) => dirToLonLat(sceneAxes(state.heading), state.frames[i].cam.basis.forward),
};

async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
