// End-to-end check in a real Chromium browser: loads the sample DJI frames into
// the app, screenshots the page and saves rendered Heli-X faces to test/browser/out.
//
//   npm run test:browser -- [photoFolder] [faceSize] [frontHeading]

import { createServer } from "vite";
import puppeteer from "puppeteer-core";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const photos = path.resolve(process.argv[2] ?? path.join(root, "../Higher_Res/001_0039"));
const size = Number(process.argv[3] ?? 1024);
const heading = Number(process.argv[4] ?? 152.5);
const out = path.join(root, "test/browser/out");
mkdirSync(out, { recursive: true });

const BROWSERS = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
].filter(Boolean);
const executablePath = BROWSERS.find((p) => existsSync(p));
if (!executablePath) throw new Error("No Chrome/Edge found; set CHROME_PATH.");

const server = await createServer({ root, server: { port: 5199, strictPort: true }, logLevel: "error" });
await server.listen();
const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"],
  defaultViewport: { width: 1200, height: 1900 },
});

let failed = false;
try {
  const page = await browser.newPage();
  page.on("console", (m) => console.log(`[page ${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => {
    failed = true;
    console.error("[page error]", e.message);
  });
  await page.goto("http://localhost:5199/", { waitUntil: "networkidle0" });

  const names = readdirSync(photos).filter((n) => /\.jpe?g$/i.test(n)).sort();
  const base = "/@fs/" + photos.replace(/\\/g, "/").replace(/^\//, "");
  console.log(`Loading ${names.length} photos from ${photos}`);
  let t = Date.now();
  await page.evaluate(async (base, names, heading) => {
    const files = await Promise.all(names.map(async (n) => new File([await (await fetch(`${base}/${n}`)).blob()], n, { type: "image/jpeg" })));
    await window.sceneMaker.loadFiles("sample", files);
    window.sceneMaker.setHeading(heading, false);
  }, base, names, heading);
  // setHeading(…, false) skips the redraw; trigger one and let it finish.
  await page.evaluate(() => document.getElementById("heading-num").dispatchEvent(new Event("change")));
  await new Promise((r) => setTimeout(r, 3000));
  console.log(`Loaded and previewed in ${((Date.now() - t) / 1000).toFixed(1)} s`);
  await page.screenshot({ path: path.join(out, "page.png"), fullPage: true });

  t = Date.now();
  const faces = await page.evaluate((size) => window.sceneMaker.renderFaces(size), size);
  console.log(`Rendered six ${size} faces from full-size photos in ${((Date.now() - t) / 1000).toFixed(1)} s`);
  for (const [face, { holes, jpeg }] of Object.entries(faces)) {
    writeFileSync(path.join(out, `face_${face}.jpg`), Buffer.from(jpeg, "base64"));
    console.log(`  ${face}: ${holes} uncovered pixels filled`);
  }
  const info = await page.evaluate(() => {
    const gl = document.getElementById("viewer").getContext("webgl2");
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    return { renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "?", floatBlend: !!gl.getExtension("EXT_float_blend") };
  });
  console.log("GPU:", info);
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
