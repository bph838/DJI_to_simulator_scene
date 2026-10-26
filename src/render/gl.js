// Small WebGL2 helpers.

export function createGL(canvas) {
  const gl = canvas.getContext("webgl2", { antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true });
  if (!gl) throw new Error("This browser does not support WebGL2. Please use a current version of Chrome.");
  if (!gl.getExtension("EXT_color_buffer_float")) {
    throw new Error("This graphics card/browser can't render to float textures (EXT_color_buffer_float).");
  }
  // 32-bit float blending gives cleaner seams; fall back to 16-bit where it is missing.
  gl.floatBlend = !!gl.getExtension("EXT_float_blend");
  gl.aniso = gl.getExtension("EXT_texture_filter_anisotropic");
  return gl;
}

export function createProgram(gl, vsSource, fsSource) {
  const compile = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error("Shader compile failed: " + gl.getShaderInfoLog(s));
    }
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl.VERTEX_SHADER, vsSource));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fsSource));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error("Shader link failed: " + gl.getProgramInfoLog(p));
  }
  const uniforms = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const name = gl.getActiveUniform(p, i).name.replace(/\[0\]$/, "");
    uniforms[name] = gl.getUniformLocation(p, name);
  }
  return { program: p, u: uniforms };
}

// Full-screen triangle; the vertex shader derives coordinates from gl_VertexID.
export const FULLSCREEN_VS = `#version 300 es
uniform vec4 u_uvRect; // x0, y0, x1, y1 of the region drawn, in target coords (y up)
out vec2 v_uv;
void main() {
  vec2 p = vec2(float((gl_VertexID & 1) << 2), float((gl_VertexID & 2) << 1)) - 1.0;
  vec2 t = p * 0.5 + 0.5;
  v_uv = mix(u_uvRect.xy, u_uvRect.zw, t);
  gl_Position = vec4(p, 0.0, 1.0);
}`;

export function drawFullscreen(gl) {
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

export function createTarget(gl, width, height, float) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  const fmt = float ? (gl.floatBlend ? gl.RGBA32F : gl.RGBA16F) : gl.RGBA8;
  gl.texStorage2D(gl.TEXTURE_2D, 1, fmt, width, height);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error("Framebuffer incomplete: 0x" + status.toString(16));
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return {
    tex, fb, width, height,
    dispose() {
      gl.deleteFramebuffer(fb);
      gl.deleteTexture(tex);
    },
  };
}

// Uploads a photo as an sRGB texture with mipmaps, so sampling returns linear light.
export function uploadPhoto(gl, source) {
  const w = source.width, h = source.height;
  const levels = 1 + Math.floor(Math.log2(Math.max(w, h)));
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texStorage2D(gl.TEXTURE_2D, levels, gl.SRGB8_ALPHA8, w, h);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  if (gl.aniso) gl.texParameterf(gl.TEXTURE_2D, gl.aniso.TEXTURE_MAX_ANISOTROPY_EXT, 8);
  return { tex, bytes: Math.round(w * h * 4 * 1.34) };
}
