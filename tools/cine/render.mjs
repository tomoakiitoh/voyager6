#!/usr/bin/env node
// 無人シネマティックレンダラ: ショットJSON → mp4 を1コマンドで。
//   node tools/cine/render.mjs tools/cine/shots/trojan_journey.json
// dist を内蔵の静的サーバで配り、システムChromeをヘッドレス(SwiftShader)で駆動して
// /solar/?cine=1 の実描画を1フレームずつ書き出し、タイトル・字幕を重ねて ffmpeg で仕上げる。
// GPU不要・完全自動。ショットJSONを差し替えれば別の動画になる（自然言語→JSON→動画の土台）。
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import puppeteer from "puppeteer-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIST = path.join(ROOT, "dist");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 8756;

const shotPath = process.argv[2];
if (!shotPath) { console.error("usage: node render.mjs <shot.json>"); process.exit(1); }
const shot = JSON.parse(fs.readFileSync(shotPath, "utf8"));
const fps = shot.fps ?? 24;
const seconds = shot.seconds ?? 7;
const [W, H] = shot.resolution ?? [1280, 720];
const jd0 = shot.jd0 ?? 2461230;
const layers = shot.layers ?? {};
const N = Math.max(2, Math.round(fps * seconds));

const OUTDIR = path.join(ROOT, "tools", "cine", "_render", shot.name);
const FRAMES = path.join(OUTDIR, "frames");
fs.rmSync(OUTDIR, { recursive: true, force: true });
fs.mkdirSync(FRAMES, { recursive: true });

// ---- カメラパスの補間 (capture.js の sample と同じ) ----
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => t * t * (3 - 2 * t);
function sampleCam(keys, t) {
  let a = keys[0], b = keys[keys.length - 1];
  for (let i = 0; i + 1 < keys.length; i++) if (t >= keys[i].t && t <= keys[i + 1].t) { a = keys[i]; b = keys[i + 1]; break; }
  const u = smooth((t - a.t) / Math.max(1e-6, b.t - a.t));
  return { cel: lerp(a.cel, b.cel, u), cdist: lerp(a.cdist, b.cdist, u), caz: lerp(a.caz, b.caz, u), dJd: lerp(a.dJd, b.dJd, u) };
}

// ---- 静的サーバ (dist を配る) ----
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".bin": "application/octet-stream", ".png": "image/png", ".svg": "image/svg+xml", ".css": "text/css" };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p.endsWith("/")) p += "index.html";
  const fp = path.join(DIST, p);
  fs.readFile(fp, (e, d) => {
    if (e) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(fp)] || "application/octet-stream" });
    res.end(d);
  });
});

// ---- タイトル/字幕を 2Dキャンバスで生成する関数 (ページ内で実行) ----
function drawCard(kind, texts, w, h) {
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const g = c.getContext("2d"); g.textAlign = "center";
  if (kind === "title") {
    g.fillStyle = "#05070d"; g.fillRect(0, 0, w, h);
    g.fillStyle = "#eaf0ff"; g.font = `600 ${Math.round(h * 0.092)}px 'Hiragino Kaku Gothic ProN',sans-serif`;
    g.fillText(texts.text, w / 2, h * 0.5);
    if (texts.sub) { g.fillStyle = "#6ea8ff"; g.font = `600 ${Math.round(h * 0.028)}px 'Hiragino Kaku Gothic ProN',sans-serif`; g.fillText(texts.sub, w / 2, h * 0.57); }
  } else {
    g.clearRect(0, 0, w, h);
    g.font = `600 ${Math.round(h * 0.047)}px 'Hiragino Kaku Gothic ProN',sans-serif`;
    g.lineWidth = 6; g.strokeStyle = "rgba(0,0,0,.7)"; g.fillStyle = "#eaf0ff";
    g.strokeText(texts.text, w / 2, h * 0.92); g.fillText(texts.text, w / 2, h * 0.92);
  }
  return c.toDataURL("image/png");
}
const saveDataUrl = (durl, file) => fs.writeFileSync(file, Buffer.from(durl.split(",")[1], "base64"));

async function main() {
  await new Promise((r) => server.listen(PORT, r));
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--no-sandbox", "--enable-webgl", "--ignore-gpu-blocklist", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
  const q = new URLSearchParams({ cine: "1", ...Object.fromEntries(Object.entries(layers).map(([k, v]) => [k, String(v)])), jd: String(jd0) });
  await page.goto(`http://127.0.0.1:${PORT}/solar/?${q}`, { waitUntil: "load" });
  await page.waitForFunction("typeof window.cineRender==='function'", { timeout: 20000 });
  await new Promise((r) => setTimeout(r, 4000)); // tier2 ロード + WebGL ウォームアップ

  if (shot.title) saveDataUrl(await page.evaluate(drawCard, "title", shot.title, W, H), path.join(FRAMES, "title.png"));
  if (shot.caption) saveDataUrl(await page.evaluate(drawCard, "caption", shot.caption, W, H), path.join(FRAMES, "caption.png"));

  process.stdout.write(`[render] ${N} frames `);
  for (let i = 0; i < N; i++) {
    const s = sampleCam(shot.camera, i / (N - 1));
    await page.evaluate((p) => window.cineRender(p), { jd: jd0 + s.dJd, ...layers, caz: s.caz, cel: s.cel, cdist: s.cdist });
    const durl = await page.evaluate(() => document.getElementById("solar-canvas").toDataURL("image/png"));
    saveDataUrl(durl, path.join(FRAMES, `f${String(i).padStart(4, "0")}.png`));
    if (i % 24 === 0) process.stdout.write(".");
  }
  process.stdout.write(" done\n");
  await browser.close();
  server.close();

  // ---- ffmpeg 組み立て ----
  const out = path.join(ROOT, "tools", "cine", `${shot.name}.mp4`);
  const dur = N / fps;
  const inputs = [];
  const parts = [];
  let idx = 0, mainLabel;
  if (shot.title) { inputs.push("-loop", "1", "-t", String(shot.title.seconds ?? 1.6), "-i", path.join(FRAMES, "title.png")); parts.push(`[${idx}:v]scale=${W}:${H},fps=${fps},setsar=1,format=yuv420p,fade=t=in:st=0:d=0.4,fade=t=out:st=${(shot.title.seconds ?? 1.6) - 0.35}:d=0.35[t]`); var titleIdx = idx; idx++; }
  inputs.push("-framerate", String(fps), "-i", path.join(FRAMES, "f%04d.png")); const framesIdx = idx; idx++;
  if (shot.caption) {
    inputs.push("-loop", "1", "-t", String(dur), "-framerate", String(fps), "-i", path.join(FRAMES, "caption.png")); const capIdx = idx; idx++;
    parts.push(`[${capIdx}:v]format=rgba,fade=t=in:st=${shot.caption.in}:d=0.5:alpha=1,fade=t=out:st=${shot.caption.out}:d=0.5:alpha=1[cap]`);
    parts.push(`[${framesIdx}:v]scale=${W}:${H}:flags=lanczos,setsar=1[m0];[m0][cap]overlay=0:0:eof_action=pass,format=yuv420p[main]`);
    mainLabel = "[main]";
  } else { parts.push(`[${framesIdx}:v]scale=${W}:${H}:flags=lanczos,setsar=1,format=yuv420p[main]`); mainLabel = "[main]"; }
  let map;
  if (shot.title) { parts.push(`[t]${mainLabel}concat=n=2:v=1:a=0[out]`); map = "[out]"; }
  else { map = mainLabel; }
  const args = ["-y", "-loglevel", "error", ...inputs, "-filter_complex", parts.join(";"), "-map", map, "-c:v", "libx264", "-crf", "28", "-preset", "veryfast", "-movflags", "+faststart", out];
  const r = spawnSync("ffmpeg", args, { stdio: "inherit" });
  if (r.status !== 0) { console.error("ffmpeg failed"); process.exit(1); }
  console.log(`-> ${path.relative(ROOT, out)}`);
  console.log(spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration,size:stream=width,height,nb_frames", "-of", "default=noprint_wrappers=1", out], { encoding: "utf8" }).stdout.trim());
}
main().catch((e) => { console.error(e); process.exit(1); });
