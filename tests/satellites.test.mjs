/**
 * 人工衛星 (PLAN6 F1) の SGP4 検証。
 *
 *   node --test tests/*.mjs
 *
 * vendoring した satellite.js (src/satellite.es.js) が、基準実装 (Python の sgp4 =
 * Vallado の参照 SGP4) と一致することを固定 TLE・固定時刻で確認する。基準値は
 * tools の外でクロスチェックして焼き込んである (scratchpad/ref_sgp4.py で再現可能):
 *   Python sgp4 と satellite.js は TEME 位置で ~1cm、topocentric alt/az で <1e-5° 一致。
 * これで「速いから正しく見える」ではなく、外部の独立実装と数値が合うことを担保する。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as sat from "../src/satellite.es.js";

// 固定 TLE (ISS, 元期 2026-204.83) と 固定時刻 2026-07-24 12:00:00 UTC
const L1 = "1 25544U 98067A   26204.83049110  .00009620  00000+0  18169-3 0  9994";
const L2 = "2 25544  51.6314 118.7564 0006921 330.4598  29.5998 15.49124476577435";
const WHEN = new Date(Date.UTC(2026, 6, 24, 12, 0, 0));
const OBS = { longitude: 139.77 * Math.PI / 180, latitude: 35.68 * Math.PI / 180, height: 0.05 };

// 基準実装 (Python sgp4 / Vallado) の出力を焼き込む
const REF_TEME = { x: -515.404111, y: -5695.001789, z: 3675.492624 };  // km
const REF = { az: 139.019194, el: 43.714575, range: 596.245303 };       // deg, deg, km

test("satellite.js の SGP4 が基準実装(Vallado)と TEME で ~1cm 一致", () => {
  const pv = sat.propagate(sat.twoline2satrec(L1, L2), WHEN);
  assert.ok(pv.position, "伝播に成功する");
  const d = Math.hypot(pv.position.x - REF_TEME.x, pv.position.y - REF_TEME.y,
    pv.position.z - REF_TEME.z);
  assert.ok(d < 0.001, `TEME 位置差 ${(d * 1000).toFixed(2)} m は 1m 未満`);
});

test("topocentric 方位・高度・距離が基準実装と <0.01° 一致", () => {
  const rec = sat.twoline2satrec(L1, L2);
  const pv = sat.propagate(rec, WHEN);
  const look = sat.ecfToLookAngles(OBS, sat.eciToEcf(pv.position, sat.gstime(WHEN)));
  const az = (look.azimuth * 180 / Math.PI + 360) % 360;
  const el = look.elevation * 180 / Math.PI;
  assert.ok(Math.abs(az - REF.az) < 0.01, `方位 ${az.toFixed(4)}° ≈ ${REF.az}°`);
  assert.ok(Math.abs(el - REF.el) < 0.01, `高度 ${el.toFixed(4)}° ≈ ${REF.el}°`);
  assert.ok(Math.abs(look.rangeSat - REF.range) < 0.05, `距離 ${look.rangeSat.toFixed(3)} km`);
});

test("ISS の軌道高度と速度が物理的に妥当", () => {
  const rec = sat.twoline2satrec(L1, L2);
  const pv = sat.propagate(rec, WHEN);
  const gd = sat.eciToGeodetic(pv.position, sat.gstime(WHEN));
  const speed = Math.hypot(pv.velocity.x, pv.velocity.y, pv.velocity.z);
  assert.ok(gd.height > 400 && gd.height < 430, `高度 ${gd.height.toFixed(1)} km は LEO`);
  assert.ok(speed > 7.6 && speed < 7.72, `速度 ${speed.toFixed(3)} km/s ≈ 7.66`);
});

test("方位・高度 → 早見盤の {e,n,u} → 方位・高度 が往復一致", () => {
  // 早見盤の規約: az = atan2(e, n), alt = asin(u)
  const azAltToEnu = (az, alt) => {
    const ca = Math.cos(alt);
    return { e: ca * Math.sin(az), n: ca * Math.cos(az), u: Math.sin(alt) };
  };
  for (const [azDeg, altDeg] of [[0, 10], [90, 45], [200, 80], [315, 2]]) {
    const az = azDeg * Math.PI / 180, alt = altDeg * Math.PI / 180;
    const h = azAltToEnu(az, alt);
    const az2 = ((Math.atan2(h.e, h.n) * 180 / Math.PI) + 360) % 360;
    const alt2 = Math.asin(h.u) * 180 / Math.PI;
    assert.ok(Math.abs(az2 - azDeg) < 1e-9, `az 往復 ${az2} ≈ ${azDeg}`);
    assert.ok(Math.abs(alt2 - altDeg) < 1e-9, `alt 往復 ${alt2} ≈ ${altDeg}`);
  }
});
