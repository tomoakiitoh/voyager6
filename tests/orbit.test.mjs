/**
 * 彗星・小惑星の軌道要素→位置 (astro.js) を JPL Horizons と突き合わせる (F3/F4)。
 *
 *   node --test tests/orbit.test.mjs
 *
 * 基準値: JPL Horizons。地心 ICRF(J2000) astrometric 赤道座標。軌道要素も Horizons の
 * 日心 J2000 黄道要素 (元期 2026-08-01 = JD 2461253.5)。Meeus 太陽(J2000)＋光行時で計算し、
 * Vesta で 5″ 一致することを確認済み。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const astro = readFileSync(path.join(ROOT, "src", "astro.js"), "utf8");
const A = new Function(
  `${astro}\nreturn {julianDay, orbitalToRaDec, orbitPosition, sunEclipticJ2000,
   cometMagnitude, asteroidMagnitude, norm360};`
)();

test("cometMagnitude: JPL式 m = M1 + 5logΔ + k1·logr (10P で Horizons と一致)", () => {
  // Horizons 10P: M1=14.2, k1=5.5。r/Δ を代入すると T-mag 13.85 に合う (2.5 は掛けない)。
  const m = A.cometMagnitude(14.2, 5.5, 1.49, 0.55);
  assert.ok(Math.abs(m - 13.85) < 0.1, `彗星等級 ${m.toFixed(2)} (期待 ≈13.85)`);
  // 純粋な式チェック
  const m2 = A.cometMagnitude(10, 8, 2.0, 1.5);
  assert.ok(Math.abs(m2 - (10 + 5 * Math.log10(1.5) + 8 * Math.log10(2.0))) < 1e-9);
});

/** 2 つの赤道座標の離角 [度]。 */
function sep(ra1, dec1, ra2, dec2) {
  const D = Math.PI / 180;
  const c = Math.sin(dec1 * D) * Math.sin(dec2 * D)
    + Math.cos(dec1 * D) * Math.cos(dec2 * D) * Math.cos((ra1 - ra2) * D);
  return Math.acos(Math.max(-1, Math.min(1, c))) / D;
}

const JD_TEST = A.julianDay(2026, 9, 15, 0); // 2026-09-15 00:00 UT

test("Vesta (楕円・M0入力) が Horizons と 15″ 以内", () => {
  const vesta = {
    e: 0.09021938861961888, a: 2.361317375478717, i: 7.143886720253887,
    node: 103.7004362500962, peri: 151.4559994083769,
    M0: 95.59804970798837, epoch: 2461253.5,
  };
  const g = A.orbitalToRaDec(vesta, JD_TEST);
  const d = sep(g.ra, g.dec, 28.05843, -0.51921) * 3600; // 秒角
  assert.ok(d < 15, `Vesta 位置が ${d.toFixed(1)}″ ずれ (RA ${g.ra.toFixed(4)} Dec ${g.dec.toFixed(4)})`);
  // 等級 (H=3.20, G=0.32) Horizons APmag 6.78
  const rs = A.sunEclipticJ2000(JD_TEST).R;
  const mag = A.asteroidMagnitude(3.20, 0.32, g.r, g.delta, rs);
  assert.ok(Math.abs(mag - 6.78) < 0.2, `Vesta 等級 ${mag.toFixed(2)} (期待 6.78)`);
});

test("Ceres (楕円・近日点通過Tp入力) が Horizons と 15″ 以内", () => {
  const ceres = {
    e: 0.07971476454442070, q: 2.545223573231570, i: 10.58786892483142,
    node: 80.24884681786273, peri: 73.26111729158177, tp: 2461599.705824837089,
  };
  const g = A.orbitalToRaDec(ceres, JD_TEST);
  const d = sep(g.ra, g.dec, 102.04781, 22.99944) * 3600;
  assert.ok(d < 15, `Ceres 位置が ${d.toFixed(1)}″ ずれ (RA ${g.ra.toFixed(4)} Dec ${g.dec.toFixed(4)})`);
  const rs = A.sunEclipticJ2000(JD_TEST).R;
  const mag = A.asteroidMagnitude(3.34, 0.12, g.r, g.delta, rs); // Ceres H=3.34 G=0.12
  assert.ok(Math.abs(mag - 8.817) < 0.2, `Ceres 等級 ${mag.toFixed(2)} (期待 8.82)`);
});

test("楕円/放物線/双曲線の分岐は e→1 で一致する (連続性)", () => {
  // 同じ q・向き・近日点通過で e を 0.995 / 1.0 / 1.005 に振る。近日点近くでは
  // どの図式でもほぼ同じ位置になるべき (3分岐の実装が正しいことの検証)。
  const base = { q: 1.3, i: 30, node: 100, peri: 50, tp: A.julianDay(2026, 9, 15) };
  const jd = base.tp + 6; // 近日点から6日後
  const ell = A.orbitPosition({ ...base, e: 0.995 }, jd);
  const par = A.orbitPosition({ ...base, e: 1.0 }, jd);
  const hyp = A.orbitPosition({ ...base, e: 1.005 }, jd);
  const ang = (u, v) => {
    const du = u.x * v.x + u.y * v.y + u.z * v.z;
    const lu = Math.hypot(u.x, u.y, u.z), lv = Math.hypot(v.x, v.y, v.z);
    return Math.acos(Math.max(-1, Math.min(1, du / (lu * lv)))) * 180 / Math.PI;
  };
  assert.ok(ang(ell, par) < 0.3, `楕円↔放物線 ${(ang(ell, par) * 60).toFixed(2)}′`);
  assert.ok(ang(hyp, par) < 0.3, `双曲線↔放物線 ${(ang(hyp, par) * 60).toFixed(2)}′`);
});
