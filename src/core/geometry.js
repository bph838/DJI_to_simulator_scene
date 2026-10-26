// World frame: East-North-Up (x = east, y = north, z = up).
// Compass headings are degrees clockwise from north, as DJI reports them.

export const DEG = Math.PI / 180;

// 35 mm full-frame diagonal, used to turn the "35 mm equivalent" focal length
// into a field of view for any sensor aspect ratio.
const FULL_FRAME_DIAGONAL_MM = Math.hypot(36, 24);

export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const add = (...vs) => vs.reduce((p, v) => [p[0] + v[0], p[1] + v[1], p[2] + v[2]], [0, 0, 0]);
export const normalize = (a) => scale(a, 1 / Math.hypot(a[0], a[1], a[2]));

// Camera axes for a gimbal pointing at heading `yaw`, tilted up by `pitch`,
// rolled clockwise by `roll` (all degrees).
export function cameraBasis(yaw, pitch, roll = 0) {
  const y = yaw * DEG, p = pitch * DEG, r = roll * DEG;
  const forward = [Math.sin(y) * Math.cos(p), Math.cos(y) * Math.cos(p), Math.sin(p)];
  let right = [Math.cos(y), -Math.sin(y), 0];
  let up = cross(right, forward);
  if (r) {
    const c = Math.cos(r), s = Math.sin(r);
    [right, up] = [add(scale(right, c), scale(up, -s)), add(scale(right, s), scale(up, c))];
  }
  return { forward, right, up };
}

// Focal length in pixels, from the 35 mm equivalent focal length.
export function focalPixels(width, height, focal35) {
  const diagonalPx = Math.hypot(width, height);
  return (focal35 / FULL_FRAME_DIAGONAL_MM) * diagonalPx;
}

// Projects a world direction into a camera. Returns normalised image coords
// (u right, v down, 0..1) or null when the direction is behind the camera.
export function project(cam, dir) {
  const z = dot(dir, cam.basis.forward);
  if (z <= 1e-6) return null;
  let x = dot(dir, cam.basis.right) / z;
  let y = dot(dir, cam.basis.up) / z;
  const r2 = x * x + y * y;
  const d = 1 + cam.k1 * r2;
  x *= d;
  y *= d;
  return { u: 0.5 + (x * cam.focalPx) / cam.width, v: 0.5 - (y * cam.focalPx) / cam.height };
}

// Inverse of project() ignoring lens distortion (fine for outlines).
export function unproject(cam, u, v) {
  const x = ((u - 0.5) * cam.width) / cam.focalPx;
  const y = (-(v - 0.5) * cam.height) / cam.focalPx;
  return normalize(add(cam.basis.forward, scale(cam.basis.right, x), scale(cam.basis.up, y)));
}

// --- Scene frame -------------------------------------------------------------

// Axes of the scene for a given "front" heading: F = front, R = pilot's right, U = up.
export function sceneAxes(frontHeading) {
  const h = frontHeading * DEG;
  const F = [Math.sin(h), Math.cos(h), 0];
  const U = [0, 0, 1];
  return { F, R: cross(F, U), U };
}

// --- Heli-X SkyBox faces -------------------------------------------------------
//
// Each face is described by the direction its centre looks (f) and the
// direction that is "up" in the picture (u). Heli-X shows the pictures mirrored
// compared with looking at them from inside the box, so the picture's +x axis
// is u x f rather than f x u. This was confirmed against a working Heli-X scene.
// Note the consequence: "_left" is the view to the pilot's right.

export const FACE_NAMES = ["front", "left", "back", "right", "top", "bottom"];

export function faceBasis(face, axes) {
  const { F, R, U } = axes;
  const neg = (v) => scale(v, -1);
  const [f, u] = {
    front: [F, U],
    back: [neg(F), U],
    left: [R, U],
    right: [neg(R), U],
    top: [U, neg(F)],
    bottom: [neg(U), F],
  }[face];
  return { f, u, r: cross(u, f) };
}

// Direction for picture coords x, y in [-1, 1] (x right, y up) on a face.
export function faceDir(fb, x, y) {
  return normalize(add(fb.f, scale(fb.r, x), scale(fb.u, y)));
}

// Direction for an equirectangular picture whose centre is the front.
// lon in [-180, 180] (positive = to the right), lat in [-90, 90].
export function equirectDir(axes, lonDeg, latDeg) {
  const lon = lonDeg * DEG, lat = latDeg * DEG;
  return add(
    scale(axes.F, Math.cos(lat) * Math.cos(lon)),
    scale(axes.R, Math.cos(lat) * Math.sin(lon)),
    scale(axes.U, Math.sin(lat)),
  );
}

export function dirToLonLat(axes, d) {
  return {
    lon: Math.atan2(dot(d, axes.R), dot(d, axes.F)) / DEG,
    lat: Math.asin(Math.max(-1, Math.min(1, dot(d, axes.U)))) / DEG,
  };
}

// --- Cameras from photo metadata -------------------------------------------------

export function makeCamera(meta, opts = {}) {
  const focal35 = opts.focal35 ?? meta.focalLength35 ?? 24;
  return {
    width: meta.width,
    height: meta.height,
    focalPx: focalPixels(meta.width, meta.height, focal35),
    k1: opts.k1 ?? 0,
    yaw: meta.gimbalYaw,
    pitch: meta.gimbalPitch,
    roll: meta.gimbalRoll ?? 0,
    basis: cameraBasis(meta.gimbalYaw, meta.gimbalPitch, meta.gimbalRoll ?? 0),
  };
}

// True if any part of the camera's picture lands inside the given region,
// tested by sampling directions across it. `dirAt(sx, sy)` maps [0,1]^2 to a direction.
// The grid is fine enough that a ~60 degree photo can't slip between samples
// for any region up to a whole face.
export function cameraSees(cam, dirAt, samples = 16) {
  for (let j = 0; j <= samples; j++) {
    for (let i = 0; i <= samples; i++) {
      const p = project(cam, dirAt(i / samples, j / samples));
      if (p && p.u >= 0 && p.u <= 1 && p.v >= 0 && p.v <= 1) return true;
    }
  }
  return false;
}
