// Writes a Heli-X SkyBox scene: <output>/<scene>/<size>/<scene>_<face>.<ext>

import { FACE_NAMES, sceneAxes } from "../core/geometry.js";
import { fillHoles } from "../core/fill.js";
import { TextureCache } from "../render/stitcher.js";
import { listNames, readTextIfExists, subdir, tryGetDir, writeFile } from "../io/folder.js";
import { ALL_SIZES, newAirportXml, setResolutions } from "./helixXml.js";

const GPU_BUDGET = 640 * 1024 * 1024;

export async function exportScene({ stitcher, frames, outDir, scene, settings, log, progress }) {
  const sizes = [...settings.sizes].sort((a, b) => b - a);
  const largest = sizes[0];
  const axes = sceneAxes(settings.frontHeading);
  const ext = settings.format === "png" ? "png" : "jpg";
  const mime = settings.format === "png" ? "image/png" : "image/jpeg";
  const sceneDir = await subdir(outDir, scene);

  // Decode full-size photos on demand; smaller outputs don't need every pixel.
  const pxPerDegNeeded = Math.max(largest / 90, settings.equirect ? settings.equirectWidth / 360 : 0);
  const textures = new TextureCache(stitcher.gl, async (f) => {
    const pxPerDeg = (f.cam.focalPx * Math.PI) / 180;
    const s = Math.min(1, (1.5 * pxPerDegNeeded) / pxPerDeg);
    return s > 0.75
      ? createImageBitmap(f.file)
      : createImageBitmap(f.file, { resizeWidth: Math.round(f.cam.width * s), resizeQuality: "high" });
  }, GPU_BUDGET);

  const steps = FACE_NAMES.length * (1 + sizes.length) + (settings.equirect ? 2 : 0);
  let step = 0;
  const tick = (label) => progress(++step / steps, label);

  try {
    for (const face of FACE_NAMES) {
      log(`Rendering ${face} at ${largest} × ${largest}…`);
      const img = await stitcher.renderFace({ frames, textures, axes, face, size: largest, settings });
      tick(`${face} rendered`);
      if (settings.fillGaps) {
        const n = fillHoles(img);
        if (n) log(`  filled ${n.toLocaleString()} uncovered pixels (${((100 * n) / (largest * largest)).toFixed(2)}%)`);
      }
      const full = new OffscreenCanvas(largest, largest);
      full.getContext("2d").putImageData(img, 0, 0);

      for (const size of sizes) {
        const canvas = size === largest ? full : downscale(full, size);
        const blob = await canvas.convertToBlob({ type: mime, quality: settings.jpegQuality });
        const dir = await subdir(sceneDir, String(size));
        await writeFile(dir, `${scene}_${face}.${ext}`, blob);
        log(`  wrote ${size}/${scene}_${face}.${ext} (${(blob.size / 1048576).toFixed(1)} MB)`);
        tick(`${face} ${size}`);
      }
    }

    if (settings.equirect) {
      const width = settings.equirectWidth;
      log(`Rendering 360° panorama ${width} × ${width / 2}…`);
      let img = await stitcher.renderEquirect({ frames, textures, axes, width, settings });
      if (settings.fillGaps) fillHoles(img);
      tick("panorama rendered");
      const c = new OffscreenCanvas(width, width / 2);
      c.getContext("2d").putImageData(img, 0, 0);
      img = null; // let the pixel copy go before encoding, these can be gigabytes
      // Always JPEG: a full-detail PNG panorama would be several hundred MB.
      const blob = await c.convertToBlob({ type: "image/jpeg", quality: settings.jpegQuality });
      // Kept beside the airport folder so it isn't shipped inside it.
      const name = `${scene}_360_${width}.jpg`;
      await writeFile(outDir, name, blob);
      log(`  wrote ${name} (${(blob.size / 1048576).toFixed(1)} MB, next to the scene folder)`);
      tick("panorama written");
    }
  } finally {
    textures.clear();
    stitcher.disposeTargets();
  }

  await warnMixedFormats(sceneDir, scene, sizes, ext, log);
  if (settings.writeXml) await writeXml(sceneDir, scene, settings, log);
}

// Halves repeatedly for a clean downscale, then finishes at the exact size.
function downscale(src, size) {
  let cur = src;
  while (cur.width / 2 >= size) {
    const next = new OffscreenCanvas(cur.width / 2, cur.height / 2);
    const ctx = next.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(cur, 0, 0, next.width, next.height);
    cur = next;
  }
  return cur;
}

async function warnMixedFormats(sceneDir, scene, sizes, ext, log) {
  const other = ext === "png" ? "jpg" : "png";
  for (const size of sizes) {
    const dir = await tryGetDir(sceneDir, String(size));
    const names = dir ? await listNames(dir) : [];
    if (names.some((n) => n.startsWith(`${scene}_`) && n.endsWith(`.${other}`))) {
      log(`  ⚠ ${size}/ also has older .${other} faces — delete them so Heli-X doesn't pick the wrong ones.`);
    }
  }
}

async function writeXml(sceneDir, scene, settings, log) {
  // A size counts as available when its folder has all six faces.
  const available = [];
  for (const size of ALL_SIZES) {
    const dir = await tryGetDir(sceneDir, String(size));
    if (!dir) continue;
    const names = await listNames(dir);
    if (FACE_NAMES.every((f) => names.some((n) => new RegExp(`^${scene}_${f}\\.(png|jpe?g)$`, "i").test(n)))) {
      available.push(size);
    }
  }
  const name = `${scene}.xml`;
  const existing = await readTextIfExists(sceneDir, name);
  const xml = existing
    ? setResolutions(existing, available)
    : newAirportXml({
        name: scene.replace(/_/g, " "),
        author: settings.author,
        comment: `Made from a DJI ${settings.droneModel ?? ""} panorama. Front heading ${settings.frontHeading.toFixed(1)}°.`,
        available,
      });
  await writeFile(sceneDir, name, new Blob([xml], { type: "application/xml" }));
  log(`${existing ? "Updated" : "Created"} ${name}: resolutions ${available.join(", ") || "none"}`);
}
