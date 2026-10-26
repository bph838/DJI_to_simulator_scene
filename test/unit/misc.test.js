import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, openSync, readSync, closeSync } from "node:fs";
import { parseJpeg, parseXmp } from "../../src/io/metadata.js";
import { fillHoles } from "../../src/core/fill.js";
import { newAirportXml, setResolutions } from "../../src/export/helixXml.js";

const SAMPLE = new URL("../../../Higher_Res/001_0039/PANO_0001.JPG", import.meta.url);

test("reads DJI gimbal data and EXIF from a real photo", { skip: !existsSync(SAMPLE) && "sample photos not present" }, () => {
  const fd = openSync(SAMPLE, "r");
  const bytes = new Uint8Array(256 * 1024);
  readSync(fd, bytes, 0, bytes.length, 0);
  closeSync(fd);
  const m = { ...parseJpeg(bytes), ...parseXmp(bytes) };
  assert.equal(m.width, 4032);
  assert.equal(m.height, 3024);
  assert.equal(m.focalLength35, 24);
  assert.equal(m.gimbalYaw, 112.6);
  assert.equal(m.gimbalPitch, -24.8);
  assert.equal(m.gimbalRoll, 0);
  assert.equal(m.model, "Mini4 Pro");
  assert.ok(Math.abs(m.exposureTime - 0.0005) < 1e-9);
  assert.ok(Math.abs(m.latitude - 51.459457208) < 1e-9);
});

test("fills a hole smoothly from its surroundings", () => {
  const W = 64, H = 64;
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      data[i] = x * 4; data[i + 1] = 100; data[i + 2] = 200;
      data[i + 3] = Math.hypot(x - 32, y - 32) < 8 ? 0 : 255;
    }
  }
  const img = { width: W, height: H, data };
  const n = fillHoles(img);
  assert.ok(n > 150);
  for (let i = 3; i < data.length; i += 4) assert.equal(data[i], 255);
  const c = (32 * W + 32) * 4;
  assert.ok(Math.abs(data[c] - 128) < 20, `red at centre ${data[c]}`);
  assert.ok(Math.abs(data[c + 1] - 100) <= 1);
  assert.equal(fillHoles(img), 0);
});

test("sets Heli-X resolution flags", () => {
  const xml = "<project>\n   <Resolution1024>false</Resolution1024>\n   <Resolution2048>true</Resolution2048>\n</project>";
  const out = setResolutions(xml, [1024, 4096]);
  assert.match(out, /<Resolution1024>true<\/Resolution1024>/);
  assert.match(out, /<Resolution2048>false<\/Resolution2048>/);
  assert.match(out, /<Resolution4096>true<\/Resolution4096>/);
  assert.match(out, /<Resolution8192>false<\/Resolution8192>/);
  assert.match(out, /<\/project>$/);
  const fresh = newAirportXml({ name: "A & B", author: "me", comment: "", available: [2048] });
  assert.match(fresh, /<Name>A &amp; B<\/Name>/);
  assert.match(fresh, /<Resolution2048>true<\/Resolution2048>/);
});
