// Flat 360° overview: the stitched panorama with each photo's outline drawn
// on top, so you can see where every frame sits and where the gaps are.

import { dirToLonLat, unproject } from "../core/geometry.js";

export function drawPanoMap(canvas, img, frames, axes, { outlines, selected }) {
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext("2d");
  // Uncovered pixels show as magenta.
  const shown = new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
  const d = shown.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) {
      d[i] = 255; d[i + 1] = 0; d[i + 2] = 255; d[i + 3] = 255;
    }
  }
  ctx.putImageData(shown, 0, 0);

  const W = canvas.width, H = canvas.height;
  const toXY = (dir) => {
    const { lon, lat } = dirToLonLat(axes, dir);
    return [(lon / 360 + 0.5) * W, (0.5 - lat / 180) * H];
  };

  // Guide lines: horizon and the front / sides / back.
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(255,255,255,0.35)";
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2);
  for (const x of [0.25, 0.75]) { ctx.moveTo(x * W, 0); ctx.lineTo(x * W, H); }
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.strokeStyle = "#ffd400";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, H);
  ctx.stroke();
  ctx.font = "bold 13px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillStyle = "#ffd400";
  ctx.fillText("FRONT", W / 2, 16);
  ctx.fillStyle = "rgba(255,255,255,0.8)";
  ctx.fillText("RIGHT", 0.75 * W, 16);
  ctx.fillText("LEFT", 0.25 * W, 16);
  ctx.fillText("BACK", 12 + 20, 16);

  if (!outlines) return;
  frames.forEach((f, i) => {
    const pts = [];
    const N = 16;
    for (let k = 0; k < N; k++) pts.push([k / N, 0]);
    for (let k = 0; k < N; k++) pts.push([1, k / N]);
    for (let k = 0; k < N; k++) pts.push([1 - k / N, 1]);
    for (let k = 0; k < N; k++) pts.push([0, 1 - k / N]);
    const xy = pts.map(([u, v]) => toXY(unproject(f.cam, u, v)));
    ctx.strokeStyle = i === selected ? "#00e5ff" : "rgba(0,229,255,0.55)";
    ctx.lineWidth = i === selected ? 2.5 : 1;
    ctx.beginPath();
    xy.forEach(([x, y], k) => {
      // Break the line where it wraps round the left/right edge.
      const prev = xy[(k + xy.length - 1) % xy.length];
      if (k === 0 || Math.abs(x - prev[0]) > W / 2) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    const first = xy[0], last = xy[xy.length - 1];
    if (Math.abs(first[0] - last[0]) <= W / 2) ctx.lineTo(first[0], first[1]);
    ctx.stroke();
    const [cx, cy] = toXY(f.cam.basis.forward);
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(cx - 11, cy - 8, 22, 15);
    ctx.fillStyle = "#00e5ff";
    ctx.font = "11px system-ui, sans-serif";
    ctx.fillText(String(i + 1), cx, cy + 4);
  });
}

// Longitude (degrees from front, + = right) under a click on the map.
export function lonAt(canvas, event) {
  const r = canvas.getBoundingClientRect();
  return ((event.clientX - r.left) / r.width - 0.5) * 360;
}
