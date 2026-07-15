"use strict";

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

/** 角度を [0, 360) に正規化する。 */
function norm360(deg) {
  const x = deg % 360;
  return x < 0 ? x + 360 : x;
}

/**
 * UTC の年月日時分秒からユリウス日を求める (グレゴリオ暦)。
 * ΔT は無視し、UT1 ≒ UTC として扱う (星座早見の精度には十分)。
 */
function julianDay(y, m, d, hh = 0, mm = 0, ss = 0) {
  if (m <= 2) { y -= 1; m += 12; }
  const A = Math.floor(y / 100);
  const B = 2 - A + Math.floor(A / 4);
  const dayFrac = d + (hh + mm / 60 + ss / 3600) / 24;
  return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1))
    + dayFrac + B - 1524.5;
}

/** JS の Date (絶対時刻) からユリウス日。 */
function jdFromDate(date) {
  return date.getTime() / 86400000 + 2440587.5;
}

/** グリニッジ平均恒星時 [度] (IAU 1982)。 */
function gmst(jd) {
  const T = (jd - 2451545.0) / 36525.0;
  const theta = 280.46061837
    + 360.98564736629 * (jd - 2451545.0)
    + 0.000387933 * T * T
    - T * T * T / 38710000.0;
  return norm360(theta);
}

/** 地方恒星時 [度]。lonDeg は東経を正とする。 */
function lst(jd, lonDeg) {
  return norm360(gmst(jd) + lonDeg);
}

/** 赤道座標 (度) を単位ベクトルへ。 */
function raDecToVec(raDeg, decDeg) {
  const ra = raDeg * DEG, dec = decDeg * DEG;
  const cd = Math.cos(dec);
  return [cd * Math.cos(ra), cd * Math.sin(ra), Math.sin(dec)];
}

/** 単位ベクトルを赤道座標 (度) へ。 */
function vecToRaDec(v) {
  return [norm360(Math.atan2(v[1], v[0]) * RAD), Math.asin(v[2]) * RAD];
}

/**
 * J2000.0 平均分点 → 指定 JD の平均分点への歳差回転行列 (Meeus 21章)。
 * 恒星位置を 0.2° 以内に保つために必要 (2026年で約 0.36° ずれる)。
 */
function precessionMatrix(jd) {
  const T = (jd - 2451545.0) / 36525.0;
  const sec = DEG / 3600;
  const zeta = (2306.2181 * T + 0.30188 * T * T + 0.017998 * T * T * T) * sec;
  const z = (2306.2181 * T + 1.09468 * T * T + 0.018203 * T * T * T) * sec;
  const theta = (2004.3109 * T - 0.42665 * T * T - 0.041833 * T * T * T) * sec;
  const cz = Math.cos(zeta), sz = Math.sin(zeta);
  const cZ = Math.cos(z), sZ = Math.sin(z);
  const ct = Math.cos(theta), st = Math.sin(theta);
  return [
    [cz * ct * cZ - sz * sZ, -sz * ct * cZ - cz * sZ, -st * cZ],
    [cz * ct * sZ + sz * cZ, -sz * ct * sZ + cz * cZ, -st * sZ],
    [cz * st, -sz * st, ct],
  ];
}

/**
 * J2000 の赤道単位ベクトル → 地平座標の成分 (東, 北, 天頂) へ変換する 3x3 行列。
 * 歳差 + 時角回転 + 緯度回転をまとめてあるので、天体ごとの計算は内積 3 回で済む。
 */
function skyMatrix(jd, latDeg, lonDeg) {
  const P = precessionMatrix(jd);
  const th = lst(jd, lonDeg) * DEG;
  const phi = latDeg * DEG;
  const cth = Math.cos(th), sth = Math.sin(th);
  const cphi = Math.cos(phi), sphi = Math.sin(phi);
  // 分点が日付のものになったベクトル v=(x,y,z) に対して
  //   A = cosδ cosH = cosθ x + sinθ y,  B = cosδ sinH = sinθ x − cosθ y,  C = sinδ = z
  //   東 = −B, 北 = cosφ C − sinφ A, 天頂 = sinφ C + cosφ A
  const H = [
    [-sth, cth, 0],                    // 東 (east)
    [-sphi * cth, -sphi * sth, cphi],  // 北 (north)
    [cphi * cth, cphi * sth, sphi],    // 天頂 (up)
  ];
  const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      M[i][j] = H[i][0] * P[0][j] + H[i][1] * P[1][j] + H[i][2] * P[2][j];
    }
  }
  return M;
}

/**
 * skyMatrix と J2000 単位ベクトルから地平座標を求める。
 * 返り値の e/n/u は東・北・天頂方向の成分 (単位ベクトル) で、描画で直接使う。
 */
function applySky(M, v) {
  const e = M[0][0] * v[0] + M[0][1] * v[1] + M[0][2] * v[2];
  const n = M[1][0] * v[0] + M[1][1] * v[1] + M[1][2] * v[2];
  const u = M[2][0] * v[0] + M[2][1] * v[1] + M[2][2] * v[2];
  return { e, n, u };
}

/**
 * applySky の逆。地平成分 {e,n,u} → J2000 赤道単位ベクトル [x,y,z]。
 * M は直交行列 (回転の積) なので逆行列は転置。vecToRaDec に渡せば RA/Dec が得られる。
 * (M は歳差込みなので、得られる RA/Dec は J2000 = 恒星カタログと同じ分点。)
 */
function applySkyInverse(M, h) {
  const e = h.e, n = h.n, u = h.u;
  return [
    M[0][0] * e + M[1][0] * n + M[2][0] * u,
    M[0][1] * e + M[1][1] * n + M[2][1] * u,
    M[0][2] * e + M[1][2] * n + M[2][2] * u,
  ];
}

/** 地平成分 → 高度・方位 [度] (方位は北=0, 東=90 の時計回り)。 */
function horizonAngles(h) {
  return {
    alt: Math.asin(Math.max(-1, Math.min(1, h.u))) * RAD,
    az: norm360(Math.atan2(h.e, h.n) * RAD),
  };
}

/**
 * 赤道座標 (J2000) → 高度・方位 [度]。単発計算・テスト用。
 * precess=false なら歳差を適用しない (日付の分点の座標をそのまま使う場合)。
 */
function eqToHorizon(raDeg, decDeg, jd, latDeg, lonDeg, precess = true) {
  let v = raDecToVec(raDeg, decDeg);
  const M = precess
    ? skyMatrix(jd, latDeg, lonDeg)
    : skyMatrixNoPrecession(jd, latDeg, lonDeg);
  return horizonAngles(applySky(M, v));
}

/** 歳差なし版 (日付の分点で与えられた座標 = 太陽・月・惑星に使う)。 */
function skyMatrixNoPrecession(jd, latDeg, lonDeg) {
  const th = lst(jd, lonDeg) * DEG;
  const phi = latDeg * DEG;
  const cth = Math.cos(th), sth = Math.sin(th);
  const cphi = Math.cos(phi), sphi = Math.sin(phi);
  return [
    [-sth, cth, 0],
    [-sphi * cth, -sphi * sth, cphi],
    [cphi * cth, cphi * sth, sphi],
  ];
}

// ---------------------------------------------------------------
// 太陽・月・惑星 (Paul Schlyter "How to compute planetary positions")
// ケプラー軌道要素 + 主要摂動。精度は分角オーダーで、星座早見には十分。
// 得られる座標は「その日付の平均分点」なので、歳差は掛けない。
// ---------------------------------------------------------------

const sin = (d) => Math.sin(d * DEG);
const cos = (d) => Math.cos(d * DEG);

/** Schlyter の時刻引数 d (1999-12-31 0:00 UT からの日数)。 */
function schlyterDay(jd) {
  return jd - 2451543.5;
}

/** 黄道傾斜角 [度]。 */
function obliquity(d) {
  return 23.4393 - 3.563e-7 * d;
}

/** 離心近点角 E [度] をケプラー方程式から解く。 */
function eccentricAnomaly(M, e) {
  let E = M + RAD * e * sin(M) * (1 + e * cos(M));
  if (e > 0.05) { // 水星のように離心率が大きいものは数回反復する
    for (let i = 0; i < 8; i++) {
      const dE = (E - RAD * e * sin(E) - M) / (1 - e * cos(E));
      E -= dE;
      if (Math.abs(dE) < 1e-8) break;
    }
  }
  return E;
}

/** 黄道座標 (黄経・黄緯 [度], 距離) → 赤道座標 [度]。 */
function eclipticToEquatorial(lonDeg, latDeg, d) {
  const o = obliquity(d);
  const x = cos(latDeg) * cos(lonDeg);
  const y = cos(latDeg) * sin(lonDeg);
  const z = sin(latDeg);
  const ye = y * cos(o) - z * sin(o);
  const ze = y * sin(o) + z * cos(o);
  return {
    ra: norm360(Math.atan2(ye, x) * RAD),
    dec: Math.atan2(ze, Math.hypot(x, ye)) * RAD,
  };
}

/** 太陽の位置 (地心)。黄経・距離 [AU] と赤道座標を返す。 */
function sunPosition(jd) {
  const d = schlyterDay(jd);
  const w = 282.9404 + 4.70935e-5 * d;   // 近日点引数
  const e = 0.016709 - 1.151e-9 * d;     // 離心率
  const M = norm360(356.0470 + 0.9856002585 * d); // 平均近点角
  const E = eccentricAnomaly(M, e);
  const x = cos(E) - e;
  const y = Math.sqrt(1 - e * e) * sin(E);
  const r = Math.hypot(x, y);                       // 距離 [AU]
  const v = Math.atan2(y, x) * RAD;                 // 真近点角
  const lon = norm360(v + w);                       // 黄経 (黄緯は 0)
  return { lon, r, M, w, ...eclipticToEquatorial(lon, 0, d) };
}

/** 月の位置 (地心)。主要摂動込み。距離は地球半径単位。 */
function moonPosition(jd) {
  const d = schlyterDay(jd);
  const N = norm360(125.1228 - 0.0529538083 * d); // 昇交点黄経
  const i = 5.1454;
  const w = norm360(318.0634 + 0.1643573223 * d); // 近地点引数
  const a = 60.2666;                              // 地球半径単位
  const e = 0.054900;
  const M = norm360(115.3654 + 13.0649929509 * d);

  const E = eccentricAnomaly(M, e);
  const xv = a * (cos(E) - e);
  const yv = a * Math.sqrt(1 - e * e) * sin(E);
  const v = Math.atan2(yv, xv) * RAD;
  const r0 = Math.hypot(xv, yv);

  // 黄道座標 (摂動前)
  const xe = r0 * (cos(N) * cos(v + w) - sin(N) * sin(v + w) * cos(i));
  const ye = r0 * (sin(N) * cos(v + w) + cos(N) * sin(v + w) * cos(i));
  const ze = r0 * sin(v + w) * sin(i);
  let lon = norm360(Math.atan2(ye, xe) * RAD);
  let lat = Math.atan2(ze, Math.hypot(xe, ye)) * RAD;
  let r = Math.hypot(xe, ye, ze);

  // 主要摂動 (Schlyter)。これを入れないと 1° 以上ずれる。
  const sun = sunPosition(jd);
  const Ls = norm360(sun.M + sun.w);   // 太陽の平均黄経
  const Lm = norm360(N + w + M);       // 月の平均黄経
  const D = norm360(Lm - Ls);          // 平均離角
  const F = norm360(Lm - N);           // 緯度引数
  const Ms = sun.M, Mm = M;

  lon += -1.274 * sin(Mm - 2 * D)      // 出差
    + 0.658 * sin(2 * D)               // 二均差
    - 0.186 * sin(Ms)                  // 年差
    - 0.059 * sin(2 * Mm - 2 * D)
    - 0.057 * sin(Mm - 2 * D + Ms)
    + 0.053 * sin(Mm + 2 * D)
    + 0.046 * sin(2 * D - Ms)
    + 0.041 * sin(Mm - Ms)
    - 0.035 * sin(D)                   // 視差不等
    - 0.031 * sin(Mm + Ms)
    - 0.015 * sin(2 * F - 2 * D)
    + 0.011 * sin(Mm - 4 * D);

  lat += -0.173 * sin(F - 2 * D)
    - 0.055 * sin(Mm - F - 2 * D)
    - 0.046 * sin(Mm + F - 2 * D)
    + 0.033 * sin(F + 2 * D)
    + 0.017 * sin(2 * Mm + F);

  r += -0.58 * cos(Mm - 2 * D) - 0.46 * cos(2 * D);

  lon = norm360(lon);
  const eq = eclipticToEquatorial(lon, lat, d);
  return { lon, lat, r, ra: eq.ra, dec: eq.dec, sunLon: sun.lon };
}

/**
 * 月の地心座標 → 地平視差を補正した観測地中心の座標。
 * 月は視差が最大 1° 近くあるので、これを入れないと精度目標を満たさない。
 */
function moonTopocentric(moon, jd, latDeg, lonDeg) {
  const mpar = Math.asin(1 / moon.r) * RAD;                 // 地平視差 [度]
  const gclat = latDeg - 0.1924 * sin(2 * latDeg);          // 地心緯度
  const rho = 0.99833 + 0.00167 * cos(2 * latDeg);          // 地心距離 (地球半径)
  const HA = norm360(lst(jd, lonDeg) - moon.ra);
  const g = Math.atan(Math.tan(gclat * DEG) / cos(HA)) * RAD;
  const ra = moon.ra - mpar * rho * cos(gclat) * sin(HA) / cos(moon.dec);
  const dec = moon.dec - mpar * rho * sin(gclat) * sin(g - moon.dec)
    / (Math.abs(sin(g)) < 1e-9 ? 1 : sin(g));
  return { ...moon, ra: norm360(ra), dec };
}

/** 惑星の軌道要素 (Schlyter)。d は schlyterDay。 */
const PLANET_ELEMENTS = {
  Mercury: (d) => ({
    N: 48.3313 + 3.24587e-5 * d, i: 7.0047 + 5.00e-8 * d,
    w: 29.1241 + 1.01444e-5 * d, a: 0.387098,
    e: 0.205635 + 5.59e-10 * d, M: 168.6562 + 4.0923344368 * d,
  }),
  Venus: (d) => ({
    N: 76.6799 + 2.46590e-5 * d, i: 3.3946 + 2.75e-8 * d,
    w: 54.8910 + 1.38374e-5 * d, a: 0.723330,
    e: 0.006773 - 1.302e-9 * d, M: 48.0052 + 1.6021302244 * d,
  }),
  Mars: (d) => ({
    N: 49.5574 + 2.11081e-5 * d, i: 1.8497 - 1.78e-8 * d,
    w: 286.5016 + 2.92961e-5 * d, a: 1.523688,
    e: 0.093405 + 2.516e-9 * d, M: 18.6021 + 0.5240207766 * d,
  }),
  Jupiter: (d) => ({
    N: 100.4542 + 2.76854e-5 * d, i: 1.3030 - 1.557e-7 * d,
    w: 273.8777 + 1.64505e-5 * d, a: 5.20256,
    e: 0.048498 + 4.469e-9 * d, M: 19.8950 + 0.0830853001 * d,
  }),
  Saturn: (d) => ({
    N: 113.6634 + 2.38980e-5 * d, i: 2.4886 - 1.081e-7 * d,
    w: 339.3939 + 2.97661e-5 * d, a: 9.55475,
    e: 0.055546 - 9.499e-9 * d, M: 316.9670 + 0.0334442282 * d,
  }),
};

/** 惑星の日心黄道直交座標。 */
function heliocentric(el) {
  const M = norm360(el.M);
  const E = eccentricAnomaly(M, el.e);
  const xv = el.a * (cos(E) - el.e);
  const yv = el.a * Math.sqrt(1 - el.e * el.e) * sin(E);
  const v = Math.atan2(yv, xv) * RAD;
  const r = Math.hypot(xv, yv);
  const u = v + el.w;
  return {
    x: r * (cos(el.N) * cos(u) - sin(el.N) * sin(u) * cos(el.i)),
    y: r * (sin(el.N) * cos(u) + cos(el.N) * sin(u) * cos(el.i)),
    z: r * sin(u) * sin(el.i),
    r,
  };
}

/**
 * 惑星の地心位置。木星・土星には主要摂動を入れる
 * (入れないと大接近周期のあたりで 0.5° 近くずれる)。
 */
function planetPosition(name, jd) {
  const d = schlyterDay(jd);
  const el = PLANET_ELEMENTS[name](d);
  const h = heliocentric(el);

  let lon = norm360(Math.atan2(h.y, h.x) * RAD);
  let lat = Math.atan2(h.z, Math.hypot(h.x, h.y)) * RAD;
  let rh = h.r;

  if (name === "Jupiter" || name === "Saturn") {
    const Mj = norm360(19.8950 + 0.0830853001 * d);
    const Msa = norm360(316.9670 + 0.0334442282 * d);
    if (name === "Jupiter") {
      lon += -0.332 * sin(2 * Mj - 5 * Msa - 67.6)
        - 0.056 * sin(2 * Mj - 2 * Msa + 21)
        + 0.042 * sin(3 * Mj - 5 * Msa + 21)
        - 0.036 * sin(Mj - 2 * Msa)
        + 0.022 * cos(Mj - Msa)
        + 0.023 * sin(2 * Mj - 3 * Msa + 52)
        - 0.016 * sin(Mj - 5 * Msa - 69);
    } else {
      lon += 0.812 * sin(2 * Mj - 5 * Msa - 67.6)
        - 0.229 * cos(2 * Mj - 4 * Msa - 2)
        + 0.119 * sin(Mj - 2 * Msa - 3)
        + 0.046 * sin(2 * Mj - 6 * Msa - 69)
        + 0.014 * sin(Mj - 3 * Msa + 32);
      lat += -0.020 * cos(2 * Mj - 4 * Msa - 2)
        + 0.018 * sin(2 * Mj - 6 * Msa - 49);
    }
    lon = norm360(lon);
  }

  // 日心黄道 → 地心黄道 (太陽の地心位置を足す)
  const sun = sunPosition(jd);
  const xh = rh * cos(lat) * cos(lon);
  const yh = rh * cos(lat) * sin(lon);
  const zh = rh * sin(lat);
  const xs = sun.r * cos(sun.lon);
  const ys = sun.r * sin(sun.lon);
  const xg = xh + xs, yg = yh + ys, zg = zh;

  const glon = norm360(Math.atan2(yg, xg) * RAD);
  const glat = Math.atan2(zg, Math.hypot(xg, yg)) * RAD;
  const R = Math.hypot(xg, yg, zg);                    // 地心距離 [AU]

  const eq = eclipticToEquatorial(glon, glat, d);
  return {
    name, ra: eq.ra, dec: eq.dec, r: rh, R,
    mag: planetMagnitude(name, rh, R, sun.r),
  };
}

/** 惑星の実視等級 (Schlyter の近似式。土星の環は無視するので最大 0.5等ほど暗く出る)。 */
function planetMagnitude(name, r, R, rs) {
  // 位相角 [度] (余弦定理)
  const cosFV = (r * r + R * R - rs * rs) / (2 * r * R);
  const FV = Math.acos(Math.max(-1, Math.min(1, cosFV))) * RAD;
  const base = 5 * Math.log10(r * R);
  switch (name) {
    case "Mercury": return -0.36 + base + 0.027 * FV + 2.2e-13 * Math.pow(FV, 6);
    case "Venus": return -4.34 + base + 0.013 * FV + 4.2e-7 * Math.pow(FV, 3);
    case "Mars": return -1.51 + base + 0.016 * FV;
    case "Jupiter": return -9.25 + base + 0.014 * FV;
    case "Saturn": return -9.0 + base + 0.044 * FV;
    default: return 0;
  }
}

/** 月の輝面比 (0=新月, 1=満月) と太陽との離角 [度]。 */
function moonPhase(moon) {
  const elong = Math.acos(
    cos(moon.lat) * cos(moon.lon - moon.sunLon)
  ) * RAD;
  const FV = 180 - elong;                 // 位相角
  return { illum: (1 + cos(FV)) / 2, elong };
}
