import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FACE_NAMES, cameraBasis, dirToLonLat, dot, equirectDir, faceBasis, faceDir, focalPixels,
  makeCamera, normalize, project, sceneAxes, unproject,
} from "../../src/core/geometry.js";

const close = (a, b, eps = 1e-9) => a.every((v, i) => Math.abs(v - b[i]) < eps);

test("camera basis follows compass headings", () => {
  const east = cameraBasis(90, 0);
  assert.ok(close(east.forward, [1, 0, 0]));
  assert.ok(close(east.right, [0, -1, 0]), "right of east is south");
  assert.ok(close(east.up, [0, 0, 1]));
  const down = cameraBasis(0, -90);
  assert.ok(close(down.forward, [0, 0, -1]));
  assert.ok(close(down.up, [0, 1, 0]), "looking straight down, picture top points north");
});

test("focal length from 35 mm equivalent matches DJI Mini 4 Pro", () => {
  const f = focalPixels(4032, 3024, 24);
  assert.ok(Math.abs(f - 2795.6) < 1, f);
  const hfov = (2 * Math.atan(2016 / f) * 180) / Math.PI;
  assert.ok(Math.abs(hfov - 71.6) < 0.2, hfov);
});

test("project and unproject round-trip", () => {
  const cam = makeCamera({ width: 4032, height: 3024, focalLength35: 24, gimbalYaw: 112.6, gimbalPitch: -24.8, gimbalRoll: 0 });
  for (const [u, v] of [[0.5, 0.5], [0.1, 0.9], [0.95, 0.05]]) {
    const p = project(cam, unproject(cam, u, v));
    assert.ok(Math.abs(p.u - u) < 1e-9 && Math.abs(p.v - v) < 1e-9);
  }
  assert.equal(project(cam, cam.basis.forward.map((x) => -x)), null);
});

test("Heli-X faces look in the right directions", () => {
  const axes = sceneAxes(152.5);
  const centre = (face) => faceDir(faceBasis(face, axes), 0, 0);
  assert.ok(close(centre("front"), axes.F, 1e-12));
  assert.ok(close(centre("back"), axes.F.map((x) => -x), 1e-12));
  // Heli-X's "_left" picture shows what is on the pilot's right (verified on a working scene).
  assert.ok(close(centre("left"), axes.R, 1e-12));
  assert.ok(close(centre("right"), axes.R.map((x) => -x), 1e-12));
  assert.ok(close(centre("top"), [0, 0, 1], 1e-12));
  assert.ok(close(centre("bottom"), [0, 0, -1], 1e-12));
});

test("Heli-X faces are mirrored, top/bottom pictures are oriented to the front", () => {
  const axes = sceneAxes(0);
  const fb = (f) => faceBasis(f, axes);
  // Front picture: its right-hand side looks toward the pilot's left.
  assert.ok(dot(faceDir(fb("front"), 1, 0), axes.R) < 0);
  // Top picture: its top edge points behind the pilot.
  assert.ok(dot(faceDir(fb("top"), 0, 1), axes.F) < 0);
  // Bottom picture: its top edge points to the front.
  assert.ok(dot(faceDir(fb("bottom"), 0, 1), axes.F) > 0);
});

test("every direction belongs to one face and maps back to itself", () => {
  const axes = sceneAxes(37);
  const bases = FACE_NAMES.map((f) => faceBasis(f, axes));
  let seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let i = 0; i < 500; i++) {
    const d = normalize([rnd(), rnd(), rnd()]);
    const b = bases.reduce((best, b) => (dot(d, b.f) > dot(d, best.f) ? b : best));
    const t = dot(d, b.f);
    const x = dot(d, b.r) / t, y = dot(d, b.u) / t;
    assert.ok(Math.abs(x) <= 1 + 1e-9 && Math.abs(y) <= 1 + 1e-9);
    assert.ok(close(faceDir(b, x, y), d, 1e-9));
  }
});

test("adjacent faces share their edges (no seams in the cube)", () => {
  const axes = sceneAxes(200);
  const bases = Object.fromEntries(FACE_NAMES.map((f) => [f, faceBasis(f, axes)]));
  for (const [name, b] of Object.entries(bases)) {
    for (const [x, y] of [[1, 0.3], [-1, -0.7], [0.2, 1], [-0.4, -1]]) {
      const d = faceDir(b, x, y);
      const others = Object.entries(bases).filter(([n, o]) => n !== name && Math.abs(dot(d, o.f) - dot(d, b.f)) < 1e-9);
      assert.equal(others.length, 1, `${name} edge point should touch exactly one neighbour`);
    }
  }
});

test("equirect centre is the front, +90 longitude is the pilot's right", () => {
  const axes = sceneAxes(152.5);
  assert.ok(close(equirectDir(axes, 0, 0), axes.F, 1e-12));
  assert.ok(close(equirectDir(axes, 90, 0), axes.R, 1e-12));
  const ll = dirToLonLat(axes, equirectDir(axes, -40, 20));
  assert.ok(Math.abs(ll.lon + 40) < 1e-9 && Math.abs(ll.lat - 20) < 1e-9);
});
