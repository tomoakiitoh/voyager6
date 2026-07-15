"use strict";

/*
 * 深い星表 (F2) のクライアント側。build_stars.py が出力した dist/stars/ の
 * タイル (10byte/星のバイナリ) と manifest.json を扱う。
 *
 * 望遠鏡モードで視野が狭まったとき、視野中心+FOV に重なるタイルだけを遅延ロードして
 * 埋め込み5等カタログに重ね描きする。グリッド定義 (帯の高さ・各帯の RA セル数 nRa) は
 * manifest からそのまま読む — 帯セル数を JS 側で再計算すると Python との丸め差で
 * ずれてタイルを取り違えるため、必ず manifest.nRa を使う。
 */

/** タイルのバイナリ (ra f32, dec f32, magQ u8, bvQ u8) を配列群へ復号する。 */
function decodeStarTile(buf, m) {
  const dv = new DataView(buf);
  const rb = m.recordBytes;
  const n = Math.floor(buf.byteLength / rb);
  const ra = new Float32Array(n), dec = new Float32Array(n);
  const mag = new Float32Array(n), bv = new Float32Array(n);
  const [mlo, mhi] = m.magRange, [blo, bhi] = m.bvRange;
  for (let i = 0; i < n; i++) {
    const o = i * rb;
    ra[i] = dv.getFloat32(o, true);
    dec[i] = dv.getFloat32(o + 4, true);
    mag[i] = mlo + dv.getUint8(o + 8) / 255 * (mhi - mlo);
    bv[i] = blo + dv.getUint8(o + 9) / 255 * (bhi - blo);
  }
  return { n, ra, dec, mag, bv };
}

/** 赤緯 [度] → 帯インデックス (build_stars.band_of と同じ)。 */
function bandOfDec(dec, m) {
  const b = Math.floor((dec + 90) / m.bandH);
  return Math.max(0, Math.min(m.nBands - 1, b));
}

/** 赤経 [度]・帯 → RA セル (build_stars.cell_of と同じ。nRa は manifest 由来)。 */
function cellOfRa(ra, band, m) {
  const n = m.nRa[band];
  const c = Math.floor(((ra % 360) + 360) % 360 / (360 / n));
  return Math.max(0, Math.min(n - 1, c));
}

/** 点 (ra,dec)[度] が属するタイルキー "band_cell"。 */
function tileKeyOf(ra, dec, m) {
  const b = bandOfDec(dec, m);
  return `${b}_${cellOfRa(ra, b, m)}`;
}

/**
 * 中心 (ra,dec)[度]・角半径 radius[度] の円に重なるタイルキーの集合。
 * RA 方向の広がりは緯度で伸びるので、帯ごとに最悪ケースの cos(dec) で見積もる。
 * (取りこぼすより少し多めに拾う。)
 */
function tileKeysForRegion(ra, dec, radius, m) {
  const keys = [];
  const decLo = Math.max(-90, dec - radius), decHi = Math.min(90, dec + radius);
  const bLo = bandOfDec(decLo, m), bHi = bandOfDec(decHi, m);
  const norm = (x) => ((x % 360) + 360) % 360;
  for (let b = bLo; b <= bHi; b++) {
    const nRa = m.nRa[b];
    if (nRa <= 1) { keys.push(`${b}_0`); continue; }
    const cellW = 360 / nRa;
    const bandDecLo = -90 + b * m.bandH, bandDecHi = bandDecLo + m.bandH;
    const maxAbsDec = Math.max(Math.abs(Math.max(bandDecLo, decLo)),
                               Math.abs(Math.min(bandDecHi, decHi)));
    const cosd = Math.cos(Math.min(89.9, maxAbsDec) * Math.PI / 180);
    const dRa = cosd > 1e-6 ? radius / cosd : 999;
    if (dRa >= 180) { // 帯を一周
      for (let c = 0; c < nRa; c++) keys.push(`${b}_${c}`);
      continue;
    }
    const cLo = Math.floor(norm(ra - dRa) / cellW);
    const cHi = Math.floor(norm(ra + dRa) / cellW);
    let c = cLo;
    for (let guard = 0; guard <= nRa; guard++) {
      keys.push(`${b}_${c}`);
      if (c === cHi) break;
      c = (c + 1) % nRa;
    }
  }
  return keys;
}
