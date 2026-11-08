// Render a Swissyphus film (HTML scene exposing window.render(t)) to MP4.
//   node render.cjs 01-weekend-in-davos.html ../01-weekend-in-davos.mp4 [fps]
// Needs Playwright with Chromium (npm i -D playwright, or a global install via NODE_PATH) and ffmpeg.
const { chromium } = require("playwright");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { execFileSync } = require("node:child_process");

(async () => {
  const [, , scene, out, fpsArg] = process.argv;
  if (!scene || !out) throw new Error("usage: node render.cjs <scene.html> <out.mp4> [fps]");
  const fps = Number(fpsArg ?? 30);
  const dir = mkdtempSync(join(tmpdir(), "sy-frames-"));
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await page.goto("file://" + resolve(scene), { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  const duration = await page.evaluate(() => window.DURATION);
  const frames = Math.round(duration * fps);
  for (let i = 0; i < frames; i++) {
    await page.evaluate((t) => window.render(t), i / fps);
    await page.screenshot({ path: join(dir, `${String(i).padStart(5, "0")}.png`) });
  }
  await browser.close();
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(fps), "-i", join(dir, "%05d.png"),
    "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart", resolve(out)]);
  rmSync(dir, { recursive: true, force: true });
  console.log(`${out}: ${frames} frames, ${duration}s @ ${fps} fps`);
})().catch((e) => { console.error(e); process.exit(1); });
