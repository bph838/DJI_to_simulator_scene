// Fills pixels no photo covered (alpha 0) with a smooth blend of the colours
// around them, using a push-pull pyramid. Meant for the small gap DJI leaves
// straight overhead. Works on a crop around the holes, so big faces stay cheap.
// Returns the number of pixels filled.

export function fillHoles(img) {
  const { width: W, height: H, data } = img;
  let x0 = W, y0 = H, x1 = -1, y1 = -1, holes = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (data[(y * W + x) * 4 + 3] === 0) {
        holes++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (!holes) return 0;
  if (holes === W * H) {
    data.fill(0);
    for (let i = 3; i < data.length; i += 4) data[i] = 255;
    return holes;
  }

  // Crop with a margin so there is plenty of real picture to pull colour from.
  // Capped: on a panorama the overhead gap spans the full width, and a margin
  // that wide would need gigabytes.
  const m = Math.min(256, Math.max(32, (x1 - x0) >> 1, (y1 - y0) >> 1));
  const cx0 = Math.max(0, x0 - m), cy0 = Math.max(0, y0 - m);
  const cx1 = Math.min(W - 1, x1 + m), cy1 = Math.min(H - 1, y1 + m);
  const w = cx1 - cx0 + 1, h = cy1 - cy0 + 1;

  // Level 0: colour premultiplied by weight (1 = real pixel, 0 = hole).
  let level = { w, h, c: new Float32Array(w * h * 3), a: new Float32Array(w * h) };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = ((cy0 + y) * W + cx0 + x) * 4, d = y * w + x;
      if (data[s + 3]) {
        level.a[d] = 1;
        level.c[d * 3] = data[s];
        level.c[d * 3 + 1] = data[s + 1];
        level.c[d * 3 + 2] = data[s + 2];
      }
    }
  }

  // Push: halve until everything is covered.
  const levels = [level];
  while (level.w > 1 || level.h > 1) {
    const nw = Math.max(1, level.w >> 1), nh = Math.max(1, level.h >> 1);
    const next = { w: nw, h: nh, c: new Float32Array(nw * nh * 3), a: new Float32Array(nw * nh) };
    let full = true;
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        let sa = 0, sr = 0, sg = 0, sb = 0;
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const sx = Math.min(level.w - 1, x * 2 + dx), sy = Math.min(level.h - 1, y * 2 + dy);
            const i = sy * level.w + sx, a = level.a[i];
            sa += a;
            sr += level.c[i * 3] * a;
            sg += level.c[i * 3 + 1] * a;
            sb += level.c[i * 3 + 2] * a;
          }
        }
        const d = y * nw + x;
        if (sa > 0) {
          next.c[d * 3] = sr / sa;
          next.c[d * 3 + 1] = sg / sa;
          next.c[d * 3 + 2] = sb / sa;
        }
        next.a[d] = Math.min(1, sa);
        if (next.a[d] < 1) full = false;
      }
    }
    // Colours are stored un-premultiplied; a is how much of the cell was real picture.
    levels.push(next);
    level = next;
    if (full) break;
  }

  // Pull: fill each level's gaps from a bilinear sample of the coarser level.
  for (let li = levels.length - 2; li >= 0; li--) {
    const fine = levels[li], coarse = levels[li + 1];
    const sx = coarse.w / fine.w, sy = coarse.h / fine.h;
    for (let y = 0; y < fine.h; y++) {
      for (let x = 0; x < fine.w; x++) {
        const d = y * fine.w + x;
        const a = fine.a[d];
        if (a >= 1) continue;
        const fx = Math.max(0, Math.min(coarse.w - 1, (x + 0.5) * sx - 0.5));
        const fy = Math.max(0, Math.min(coarse.h - 1, (y + 0.5) * sy - 0.5));
        const ix = Math.floor(fx), iy = Math.floor(fy);
        const jx = Math.min(coarse.w - 1, ix + 1), jy = Math.min(coarse.h - 1, iy + 1);
        const tx = fx - ix, ty = fy - iy;
        for (let k = 0; k < 3; k++) {
          const v =
            (coarse.c[(iy * coarse.w + ix) * 3 + k] * (1 - tx) + coarse.c[(iy * coarse.w + jx) * 3 + k] * tx) * (1 - ty) +
            (coarse.c[(jy * coarse.w + ix) * 3 + k] * (1 - tx) + coarse.c[(jy * coarse.w + jx) * 3 + k] * tx) * ty;
          fine.c[d * 3 + k] = fine.c[d * 3 + k] * a + v * (1 - a);
        }
        fine.a[d] = 1;
      }
    }
  }

  const top = levels[0];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = ((cy0 + y) * W + cx0 + x) * 4;
      if (data[s + 3]) continue;
      const d = y * w + x;
      data[s] = top.c[d * 3];
      data[s + 1] = top.c[d * 3 + 1];
      data[s + 2] = top.c[d * 3 + 2];
      data[s + 3] = 255;
    }
  }
  return holes;
}
