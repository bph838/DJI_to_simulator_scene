// Renders cube faces / equirect panoramas from the drone photos on the GPU.
//
// For every output pixel we work out its viewing direction, find where that
// direction lands in each photo, and blend the photos with weights that fade
// to zero at photo edges. Accumulation is done in linear light in a float
// buffer, then normalised and converted back to sRGB.

import { FULLSCREEN_VS, createProgram, createTarget, drawFullscreen, uploadPhoto } from "./gl.js";
import { cameraSees, equirectDir, faceBasis, faceDir } from "../core/geometry.js";

const ACCUM_FS = `#version 300 es
precision highp float;
uniform int u_mode;            // 0 = cube face, 1 = equirect
uniform vec3 u_a, u_b, u_c;    // face: f, r, u   |  equirect: F, R, U
uniform vec3 u_camR, u_camU, u_camF;
uniform vec2 u_focal;          // focal length / image width, / image height
uniform float u_k1;
uniform float u_gain;
uniform float u_feather;
uniform sampler2D u_img;
in vec2 v_uv;
out vec4 o;

const float PI = 3.14159265358979;

vec3 viewDir() {
  if (u_mode == 0) {
    vec2 p = v_uv * 2.0 - 1.0;
    return normalize(u_a + p.x * u_b + p.y * u_c);
  }
  float lon = (v_uv.x - 0.5) * 2.0 * PI;
  float lat = (v_uv.y - 0.5) * PI;
  return u_a * cos(lat) * cos(lon) + u_b * cos(lat) * sin(lon) + u_c * sin(lat);
}

void main() {
  vec3 d = viewDir();
  float z = dot(d, u_camF);
  vec2 xy = vec2(dot(d, u_camR), dot(d, u_camU)) / max(z, 1e-4);
  xy *= 1.0 + u_k1 * dot(xy, xy);
  vec2 t = vec2(0.5 + xy.x * u_focal.x, 0.5 - xy.y * u_focal.y);
  // Derivatives must be taken before any discard.
  vec2 tdx = dFdx(t), tdy = dFdy(t);
  if (z <= 1e-4) discard;
  if (any(lessThan(t, vec2(0.0))) || any(greaterThan(t, vec2(1.0)))) discard;
  vec2 e = min(t, 1.0 - t) * 2.0;           // 0 at the photo edge, 1 at its centre
  float w = pow(e.x * e.y, u_feather) + 1e-6;
  vec3 c = textureGrad(u_img, t, tdx, tdy).rgb * u_gain;
  o = vec4(c * w, w);
}`;

const NORMALISE_FS = `#version 300 es
precision highp float;
uniform sampler2D u_acc;
uniform float u_minWeight;
out vec4 o;

vec3 toSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main() {
  vec4 a = texelFetch(u_acc, ivec2(gl_FragCoord.xy), 0);
  o = a.a < u_minWeight ? vec4(0.0) : vec4(toSrgb(a.rgb / a.a), 1.0);
}`;

export const TILE = 2048;

export class Stitcher {
  constructor(gl) {
    this.gl = gl;
    this.accum = createProgram(gl, FULLSCREEN_VS, ACCUM_FS);
    this.normalise = createProgram(gl, FULLSCREEN_VS, NORMALISE_FS);
    this.vao = gl.createVertexArray();
    this.targets = new Map();
  }

  target(size, float) {
    const key = `${size}:${float}`;
    if (!this.targets.has(key)) this.targets.set(key, createTarget(this.gl, size, size, float));
    return this.targets.get(key);
  }

  disposeTargets() {
    for (const t of this.targets.values()) t.dispose();
    this.targets.clear();
  }

  // Renders one Heli-X face. Returns ImageData (top row first); pixels no photo
  // covers have alpha 0.
  async renderFace({ frames, textures, axes, face, size, settings, onFrame }) {
    const fb = faceBasis(face, axes);
    const region = (x0, y0, x1, y1) => (sx, sy) =>
      faceDir(fb, (x0 + (x1 - x0) * sx) * 2 - 1, (y0 + (y1 - y0) * sy) * 2 - 1);
    return this.#renderTiled({
      width: size, height: size, frames, textures, settings, onFrame,
      mode: 0, abc: [fb.f, fb.r, fb.u], region,
    });
  }

  // Renders an equirectangular panorama (width = 2 x height) centred on the front.
  async renderEquirect({ frames, textures, axes, width, settings, onFrame }) {
    const region = (x0, y0, x1, y1) => (sx, sy) =>
      equirectDir(axes, ((x0 + (x1 - x0) * sx) - 0.5) * 360, ((y0 + (y1 - y0) * sy) - 0.5) * 180);
    return this.#renderTiled({
      width, height: width / 2, frames, textures, settings, onFrame,
      mode: 1, abc: [axes.F, axes.R, axes.U], region,
    });
  }

  async #renderTiled({ width, height, frames, textures, settings, onFrame, mode, abc, region }) {
    const gl = this.gl;
    const out = new ImageData(width, height);
    const tile = Math.min(TILE, Math.max(width, height));
    const acc = this.target(tile, true);
    const ldr = this.target(tile, false);
    const pixels = new Uint8Array(tile * tile * 4);

    for (let ty = 0; ty < height; ty += tile) {
      for (let tx = 0; tx < width; tx += tile) {
        const tw = Math.min(tile, width - tx), th = Math.min(tile, height - ty);
        // Region in target coords with y up (row 0 of the picture is the top).
        const x0 = tx / width, x1 = (tx + tw) / width;
        const y1 = 1 - ty / height, y0 = 1 - (ty + th) / height;
        const sees = region(x0, y0, x1, y1);
        const visible = frames.filter((f) => cameraSees(f.cam, sees));

        gl.bindFramebuffer(gl.FRAMEBUFFER, acc.fb);
        gl.viewport(0, 0, tw, th);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE);
        gl.useProgram(this.accum.program);
        gl.bindVertexArray(this.vao);
        const u = this.accum.u;
        gl.uniform4f(u.u_uvRect, x0, y0, x1, y1);
        gl.uniform1i(u.u_mode, mode);
        gl.uniform3fv(u.u_a, abc[0]);
        gl.uniform3fv(u.u_b, abc[1]);
        gl.uniform3fv(u.u_c, abc[2]);
        gl.uniform1f(u.u_feather, settings.feather);
        gl.uniform1i(u.u_img, 0);

        for (const f of visible) {
          const tex = await textures.get(f);
          gl.bindFramebuffer(gl.FRAMEBUFFER, acc.fb);
          gl.viewport(0, 0, tw, th);
          gl.useProgram(this.accum.program);
          gl.bindVertexArray(this.vao);
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, tex);
          gl.uniform3fv(u.u_camR, f.cam.basis.right);
          gl.uniform3fv(u.u_camU, f.cam.basis.up);
          gl.uniform3fv(u.u_camF, f.cam.basis.forward);
          gl.uniform2f(u.u_focal, f.cam.focalPx / f.cam.width, f.cam.focalPx / f.cam.height);
          gl.uniform1f(u.u_k1, f.cam.k1);
          gl.uniform1f(u.u_gain, settings.exposure ? f.gain : 1);
          drawFullscreen(gl);
          onFrame?.(f);
        }
        gl.disable(gl.BLEND);

        gl.bindFramebuffer(gl.FRAMEBUFFER, ldr.fb);
        gl.viewport(0, 0, tw, th);
        gl.useProgram(this.normalise.program);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, acc.tex);
        gl.uniform1i(this.normalise.u.u_acc, 0);
        gl.uniform1f(this.normalise.u.u_minWeight, 1e-5);
        drawFullscreen(gl);
        gl.readPixels(0, 0, tw, th, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

        // GL rows run bottom-up; flip into the picture.
        for (let r = 0; r < th; r++) {
          const src = pixels.subarray((th - 1 - r) * tw * 4, (th - r) * tw * 4);
          out.data.set(src, ((ty + r) * width + tx) * 4);
        }
        // Let the page breathe between tiles.
        await new Promise((res) => setTimeout(res, 0));
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return out;
  }
}

// Keeps photo textures on the GPU up to a memory budget, least recently used
// first out. `load(frame)` must resolve to an ImageBitmap (or canvas).
export class TextureCache {
  constructor(gl, load, budgetBytes) {
    this.gl = gl;
    this.load = load;
    this.budget = budgetBytes;
    this.entries = new Map(); // frame -> { tex, bytes }
    this.used = 0;
  }

  async get(frame) {
    let e = this.entries.get(frame);
    if (e) {
      this.entries.delete(frame);
      this.entries.set(frame, e);
      return e.tex;
    }
    const bitmap = await this.load(frame);
    e = uploadPhoto(this.gl, bitmap);
    if (bitmap.close && bitmap !== frame.thumb) bitmap.close();
    while (this.used + e.bytes > this.budget && this.entries.size) {
      const [oldFrame, old] = this.entries.entries().next().value;
      this.gl.deleteTexture(old.tex);
      this.used -= old.bytes;
      this.entries.delete(oldFrame);
    }
    this.entries.set(frame, e);
    this.used += e.bytes;
    return e.tex;
  }

  clear() {
    for (const e of this.entries.values()) this.gl.deleteTexture(e.tex);
    this.entries.clear();
    this.used = 0;
  }
}
