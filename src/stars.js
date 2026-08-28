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

/* ============================================================================
 * v1 深層 (20等星図)。dist/stars_v1/ ・ data.voyager6.net/stars/v1/ を読む第2経路。
 *
 * 上の現行タイル (AT-HYG ≤10等・10°帯グリッド) とは**別物**として並存させる。
 * 現行は Pages 同梱のフォールバックで、VR (stars_deep.bin) と観測星図 (star_names.json)
 * も同じビルドから出ているため、触ると三方向に波及する。v1 は 10 等より暗い星しか
 * 持たないので、原理的に二重描画にならない。
 *
 * **manifest が正。JS 側で層や nside を再計算しない。**
 * 現行グリッドで Python↔JS の丸め差からセルを取り違えた前例があるため、
 * 層の等級範囲・nside・存在するタイル一覧はすべて manifest からそのまま読む。
 * ここで自前計算するのは HEALPix の ang2pix だけで、それは
 * tests/fixtures/healpix_ang2pix.json (astropy-healpix 由来) で Python 実装と
 * 同時に固定してある。
 * ========================================================================== */

// ix,iy を交互ビットへ織り込むための表 (下位8bitぶん)。nside <= 2^16 まで扱える。
const HPX_UTAB = (() => {
  const t = new Int32Array(256);
  for (let m = 0; m < 256; m++) {
    let v = 0;
    for (let b = 0; b < 8; b++) v |= ((m >> b) & 1) << (2 * b);
    t[m] = v;
  }
  return t;
})();

/** ix,iy を交互ビットで 1 つの整数へ。2^32 を超えるので乗算で合成する。 */
function hpxInterleave(ix, iy) {
  const lo = HPX_UTAB[ix & 0xff] | (HPX_UTAB[(ix >> 8) & 0xff] * 0x10000);
  const hi = HPX_UTAB[iy & 0xff] | (HPX_UTAB[(iy >> 8) & 0xff] * 0x10000);
  return lo + hi * 2;
}

/**
 * 赤経・赤緯 [度] → HEALPix nested index。nside は 2 のべき。
 * HEALPix C の ang2pix_nest の移植 (Górski et al. 2005)。
 * tools/healpix.py と同一のコードで、同じ fixture に対して両方をテストしている。
 * ※ 面の角ちょうど (dec=0 かつ ra が45°の倍数) は4画素の同点で実装差が出るが、
 *    実在の星がそこに厳密に乗ることはない (fixture の ties 参照)。
 */
function ang2pixNest(nside, raDeg, decDeg) {
  const order = Math.round(Math.log2(nside));
  const z = Math.sin(decDeg * Math.PI / 180);   // cos(余緯度)
  const za = Math.abs(z);
  const tt = (((raDeg % 360) + 360) % 360) / 90;   // 面の幅=90° 単位。0<=tt<4
  let face, ix, iy;

  if (za <= 2 / 3) {
    // 赤道帯: 面の境界が斜めに走るので、上り線と下り線の番号で面を決める
    const temp1 = nside * (0.5 + tt);
    const temp2 = nside * z * 0.75;
    const jp = Math.trunc(temp1 - temp2);
    const jm = Math.trunc(temp1 + temp2);
    const ifp = Math.floor(jp / nside);          // >> order 相当 (jp は 2^31 を超え得る)
    const ifm = Math.floor(jm / nside);
    if (ifp === ifm) face = (ifp & 3) + 4;
    else if (ifp < ifm) face = ifp & 3;
    else face = (ifm & 3) + 8;
    ix = jm & (nside - 1);
    iy = nside - (jp & (nside - 1)) - 1;
  } else {
    // 極冠: 面内が正方格子なので、面の中の相対位置を直接出す
    const ntt = Math.min(3, Math.trunc(tt));
    const tp = tt - ntt;
    const tmp = nside * Math.sqrt(3 * (1 - za));
    const jp = Math.min(nside - 1, Math.trunc(tp * tmp));
    const jm = Math.min(nside - 1, Math.trunc((1 - tp) * tmp));
    if (z >= 0) { face = ntt; ix = nside - jm - 1; iy = nside - jp - 1; }
    else { face = ntt + 8; ix = jp; iy = jm; }
  }
  return face * nside * nside + hpxInterleave(ix, iy);
}

/**
 * v1 タイルの復号。header 16byte (ra0,dec0,raSpan,decSpan f32) + 6byte/星。
 * 量子化の範囲は**層の等級範囲と manifest の colRange**から作る (ここで決め打ちしない)。
 */
function decodeStarTileV1(buf, layer, manifest) {
  const dv = new DataView(buf);
  const hb = manifest.headerBytes, rb = manifest.recordBytes;
  const ra0 = dv.getFloat32(0, true), dec0 = dv.getFloat32(4, true);
  const raSpan = dv.getFloat32(8, true), decSpan = dv.getFloat32(12, true);
  const n = Math.floor((buf.byteLength - hb) / rb);
  const ra = new Float32Array(n), dec = new Float32Array(n);
  const mag = new Float32Array(n), col = new Float32Array(n);
  const mlo = layer.magMin, mspan = layer.magMax - layer.magMin;
  const [clo, chi] = manifest.colRange, cspan = chi - clo;
  for (let i = 0; i < n; i++) {
    const o = hb + i * rb;
    ra[i] = (ra0 + dv.getUint16(o, true) / 65535 * raSpan) % 360;
    dec[i] = dec0 + dv.getUint16(o + 2, true) / 65535 * decSpan;
    mag[i] = mlo + dv.getUint8(o + 4) / 255 * mspan;
    col[i] = clo + dv.getUint8(o + 5) / 255 * cspan;
  }
  return { n, ra, dec, mag, col };
}

/**
 * 中心 (ra,dec)[度]・角半径 radius[度] の円に重なる HEALPix pix の集合。
 *
 * query_disc は移植しない (境界の扱いが込み入っていて、移植ミスの方が怖い)。
 * 代わりに**円内に格子点を撒いて ang2pix を集める**。ピクセル辺長の半分以下の
 * 間隔で撒けば取りこぼさない。取り過ぎ (空タイルを引きに行く) は manifest の
 * tiles に無ければ捨てるだけなので害がない。
 */
function pixelsForRegionV1(nside, raDeg, decDeg, radiusDeg, maxSamples) {
  const out = new Set();
  // ピクセルの辺長 [度] ≒ sqrt(4π/(12 nside²)) をラジアンから度へ
  const pixDeg = Math.sqrt(4 * Math.PI / (12 * nside * nside)) * 180 / Math.PI;
  let step = pixDeg / 2;
  const cap = maxSamples || 2000;
  // 点数が上限を超えるなら間隔を広げる (円の面積 / 格子の面積 で概算)
  const nEst = () => Math.PI * radiusDeg * radiusDeg / (step * step);
  if (nEst() > cap) step = radiusDeg * Math.sqrt(Math.PI / cap);

  const cd = Math.cos(decDeg * Math.PI / 180);
  for (let dd = -radiusDeg; dd <= radiusDeg + 1e-9; dd += step) {
    const dec = decDeg + dd;
    if (dec > 90 || dec < -90) { out.add(ang2pixNest(nside, raDeg, dec > 90 ? 90 : -90)); continue; }
    const half = Math.sqrt(Math.max(0, radiusDeg * radiusDeg - dd * dd));
    // RA 方向は cos(dec) で伸びる。極では一周させる
    const c = Math.cos(dec * Math.PI / 180);
    if (c < 1e-6 || half / c >= 180) {
      for (let a = 0; a < 360; a += Math.max(step, 360 / 720)) out.add(ang2pixNest(nside, a, dec));
      continue;
    }
    const dRa = half / c;
    const raStep = Math.max(step / Math.max(c, 1e-6), 1e-6);
    for (let da = -dRa; da <= dRa + 1e-9; da += raStep) out.add(ang2pixNest(nside, raDeg + da, dec));
    out.add(ang2pixNest(nside, raDeg + dRa, dec));
  }
  out.add(ang2pixNest(nside, raDeg, decDeg));
  return out;
}
