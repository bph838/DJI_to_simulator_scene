// Drag-to-look viewer that displays six Heli-X face pictures. It undoes the
// Heli-X face convention, so a correct-looking view means the files are right.

import { FULLSCREEN_VS, createProgram, drawFullscreen } from "./gl.js";
import { DEG, FACE_NAMES, add, cross, faceBasis, scale } from "../core/geometry.js";

const VIEW_FS = `#version 300 es
precision highp float;
uniform vec3 u_viewF, u_viewR, u_viewU;
uniform float u_tanHalf, u_aspect;
uniform vec3 u_f[6], u_r[6], u_u[6];
uniform sampler2D u_face0, u_face1, u_face2, u_face3, u_face4, u_face5;
uniform bool u_grid;
in vec2 v_uv;
out vec4 o;

vec4 sampleFace(int i, vec2 st) {
  if (i == 0) return texture(u_face0, st);
  if (i == 1) return texture(u_face1, st);
  if (i == 2) return texture(u_face2, st);
  if (i == 3) return texture(u_face3, st);
  if (i == 4) return texture(u_face4, st);
  return texture(u_face5, st);
}

void main() {
  vec2 p = v_uv * 2.0 - 1.0;
  vec3 d = normalize(u_viewF + p.x * u_tanHalf * u_aspect * u_viewR + p.y * u_tanHalf * u_viewU);
  int best = 0;
  float bt = -2.0;
  for (int i = 0; i < 6; i++) {
    float t = dot(d, u_f[i]);
    if (t > bt) { bt = t; best = i; }
  }
  vec2 xy = vec2(dot(d, u_r[best]), dot(d, u_u[best])) / bt;
  // Picture row 0 is the top, and textures are uploaded top row first.
  vec2 st = vec2(xy.x + 1.0, 1.0 - xy.y) * 0.5;
  vec4 c = sampleFace(best, st);
  if (c.a < 0.5) c = vec4(1.0, 0.0, 1.0, 1.0);   // uncovered: magenta
  if (u_grid) {
    // Face borders, to show where the cube seams are.
    vec2 edge = 1.0 - abs(xy);
    float px = fwidth(xy.x) * 1.5;
    if (min(edge.x, edge.y) < px) c.rgb = mix(c.rgb, vec3(1.0, 0.85, 0.0), 0.8);
  }
  o = vec4(c.rgb, 1.0);
}`;

export class Viewer {
  constructor(gl, canvas) {
    this.gl = gl;
    this.canvas = canvas;
    this.prog = createProgram(gl, FULLSCREEN_VS, VIEW_FS);
    this.vao = gl.createVertexArray();
    this.textures = FACE_NAMES.map(() => gl.createTexture());
    this.yaw = 0;   // degrees, relative to the front
    this.pitch = 0;
    this.fov = 75;
    this.grid = false;
    this.ready = false;
    this.#bindInput();
  }

  // faces: { front: canvas|ImageBitmap, ... }; axes: scene axes used to make them.
  setFaces(faces, axes) {
    const gl = this.gl;
    FACE_NAMES.forEach((name, i) => {
      gl.bindTexture(gl.TEXTURE_2D, this.textures[i]);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, faces[name]);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    });
    this.axes = axes;
    this.ready = true;
    this.draw();
  }

  draw() {
    if (!this.ready) return;
    const gl = this.gl, c = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(c.clientWidth * dpr), h = Math.round(c.clientHeight * dpr);
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    const { F, R, U } = this.axes;
    const y = this.yaw * DEG, p = this.pitch * DEG;
    const flat = add(scale(F, Math.cos(y)), scale(R, Math.sin(y)));
    const viewF = add(scale(flat, Math.cos(p)), scale(U, Math.sin(p)));
    const viewR = add(scale(F, -Math.sin(y)), scale(R, Math.cos(y)));
    const viewU = cross(viewR, viewF);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.disable(gl.BLEND);
    gl.useProgram(this.prog.program);
    gl.bindVertexArray(this.vao);
    const u = this.prog.u;
    gl.uniform4f(u.u_uvRect, 0, 0, 1, 1);
    gl.uniform3fv(u.u_viewF, viewF);
    gl.uniform3fv(u.u_viewR, viewR);
    gl.uniform3fv(u.u_viewU, viewU);
    gl.uniform1f(u.u_tanHalf, Math.tan((this.fov * DEG) / 2));
    gl.uniform1f(u.u_aspect, w / h);
    gl.uniform1i(u.u_grid, this.grid);
    const bases = FACE_NAMES.map((n) => faceBasis(n, this.axes));
    gl.uniform3fv(u.u_f, bases.flatMap((b) => b.f));
    gl.uniform3fv(u.u_r, bases.flatMap((b) => b.r));
    gl.uniform3fv(u.u_u, bases.flatMap((b) => b.u));
    this.textures.forEach((t, i) => {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.uniform1i(u[`u_face${i}`], i);
    });
    drawFullscreen(gl);
    gl.activeTexture(gl.TEXTURE0);
    this.onView?.(this.yaw, this.pitch);
  }

  lookAt(yaw, pitch = this.pitch) {
    this.yaw = ((((yaw + 180) % 360) + 360) % 360) - 180;
    this.pitch = Math.max(-89, Math.min(89, pitch));
    this.draw();
  }

  #bindInput() {
    const c = this.canvas;
    let drag = null;
    c.addEventListener("pointerdown", (e) => {
      drag = { x: e.clientX, y: e.clientY, yaw: this.yaw, pitch: this.pitch };
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const degPerPx = this.fov / c.clientHeight;
      this.lookAt(drag.yaw - (e.clientX - drag.x) * degPerPx, drag.pitch + (e.clientY - drag.y) * degPerPx);
    });
    c.addEventListener("pointerup", () => (drag = null));
    c.addEventListener("wheel", (e) => {
      e.preventDefault();
      this.fov = Math.max(20, Math.min(120, this.fov * Math.exp(e.deltaY * 0.001)));
      this.draw();
    }, { passive: false });
    new ResizeObserver(() => this.draw()).observe(c);
  }
}
