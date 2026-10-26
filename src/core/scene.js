// A set of drone photos ready for stitching.

import { readMetadata } from "../io/metadata.js";
import { makeCamera } from "./geometry.js";

const THUMB_WIDTH = 1024;
const EARTH_RADIUS_M = 6371000;

export async function loadFrames(files, onProgress) {
  const frames = [];
  const skipped = [];
  let n = 0;
  for (const file of files) {
    const meta = await readMetadata(file);
    onProgress?.(++n / files.length / 2, file.name);
    if (!Number.isFinite(meta.gimbalYaw) || !Number.isFinite(meta.gimbalPitch) || !meta.width) {
      skipped.push({ name: file.name, reason: "no DJI gimbal data" });
      continue;
    }
    frames.push({ name: file.name, file, meta });
  }
  if (!frames.length) return { frames, skipped };

  // All photos must come from the same camera setup.
  const { width, height } = frames[0].meta;
  for (const f of frames.filter((f) => f.meta.width !== width || f.meta.height !== height)) {
    skipped.push({ name: f.name, reason: `size ${f.meta.width}x${f.meta.height} differs from ${width}x${height}` });
  }
  const kept = frames.filter((f) => f.meta.width === width && f.meta.height === height);

  n = 0;
  for (const f of kept) {
    f.thumb = await createImageBitmap(f.file, { resizeWidth: THUMB_WIDTH, resizeQuality: "high" });
    onProgress?.(0.5 + ++n / kept.length / 2, f.name);
  }
  setExposureGains(kept);
  return { frames: kept, skipped };
}

// The camera kept ISO and aperture fixed and only changed shutter speed, so
// scaling each photo by (reference time / its time) in linear light evens them out.
export function setExposureGains(frames) {
  const times = frames.map((f) => f.meta.exposureTime).filter((t) => t > 0).sort((a, b) => a - b);
  const ref = times.length ? times[Math.floor(times.length / 2)] : 0;
  for (const f of frames) {
    const t = f.meta.exposureTime;
    const iso = (f.meta.iso || 100) / (frames[0].meta.iso || 100);
    const fnum = (frames[0].meta.fNumber || 1) / (f.meta.fNumber || 1);
    f.gain = ref && t ? ref / (t * iso * fnum * fnum) : 1;
  }
}

export function buildCameras(frames, opts) {
  for (const f of frames) f.cam = makeCamera(f.meta, opts);
}

export function summarise(frames) {
  const m = frames[0].meta;
  const lat0 = mean(frames.map((f) => f.meta.latitude));
  const lon0 = mean(frames.map((f) => f.meta.longitude));
  let drift = 0;
  for (const f of frames) {
    const dy = (f.meta.latitude - lat0) * (Math.PI / 180) * EARTH_RADIUS_M;
    const dx = (f.meta.longitude - lon0) * (Math.PI / 180) * EARTH_RADIUS_M * Math.cos(lat0 * (Math.PI / 180));
    drift = Math.max(drift, Math.hypot(dx, dy));
  }
  const exposures = frames.map((f) => f.meta.exposureTime).filter(Boolean);
  return {
    count: frames.length,
    model: m.model,
    size: `${m.width} × ${m.height}`,
    focal35: m.focalLength35,
    taken: m.createDate,
    latitude: lat0,
    longitude: lon0,
    height: mean(frames.map((f) => f.meta.relativeAltitude)),
    drift,
    exposureRange: exposures.length ? [Math.min(...exposures), Math.max(...exposures)] : null,
  };
}

function mean(xs) {
  const v = xs.filter(Number.isFinite);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
}
