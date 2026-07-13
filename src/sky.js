"use strict";

/**
 * 出没・薄明・観望好機の計算。astro.js に依存する。
 *
 * 天体の高度が閾値を横切る瞬間を数値的に求める方式で統一している。
 * 解析解を使わないぶん遅いが、太陽・月・惑星をまったく同じコードで扱えるし、
 * 高緯度で「沈まない/昇らない」ケースも自然に「見つからない」で表現できる。
 *
 * 精度: astro.js の位置精度がそのまま効く。
 *   太陽 (0.3°) → 出没時刻の誤差 1分程度
 *   月   (0.5°) → 同 2〜3分程度  ... なので秒までは表示しないこと。
 */

// 出没とみなす高度 [度]
const ALT_SUNRISE = -0.833;   // 大気差 34' + 太陽の視半径 16'
const ALT_MOONRISE = 0.125;   // 大気差 34' − 地平視差 57' + 月の視半径 16'
const ALT_PLANET = -0.566;    // 大気差 34' のみ (視半径は無視できる)
const TWILIGHT = { civil: -6, nautical: -12, astronomical: -18 };

/** 天体の高度 [度] を返す関数を作る。名前は "sun" / "moon" / 惑星の英名。 */
function altitudeFn(body, lat, lon) {
  return (ms) => {
    const jd = jdFromDate(new Date(ms));
    let eq;
    if (body === "sun") eq = sunPosition(jd);
    else if (body === "moon") eq = moonTopocentric(moonPosition(jd), jd, lat, lon);
    else eq = planetPosition(body, jd);
    return eqToHorizon(eq.ra, eq.dec, jd, lat, lon, false).alt;
  };
}

/**
 * [from, to) の間で高度が target を横切る瞬間を全部拾う。
 * 粗く (既定10分) 走査して符号の変わる区間を見つけ、二分法で1秒まで詰める。
 * 返り値: [{ ms, rising }] — rising=true なら上昇中の交差 (= 出)。
 */
function findCrossings(altFn, from, to, target, stepMs = 10 * 60000) {
  const out = [];
  let t0 = from, a0 = altFn(t0) - target;
  for (let t1 = from + stepMs; t1 <= to; t1 += stepMs) {
    const a1 = altFn(t1) - target;
    if (a0 === 0 || (a0 < 0) !== (a1 < 0)) {
      let lo = t0, hi = t1, alo = a0;
      while (hi - lo > 1000) {                 // 1秒まで詰める
        const mid = (lo + hi) / 2;
        const am = altFn(mid) - target;
        if ((alo < 0) === (am < 0)) { lo = mid; alo = am; } else { hi = mid; }
      }
      out.push({ ms: Math.round((lo + hi) / 2), rising: a1 > a0 });
    }
    t0 = t1; a0 = a1;
  }
  return out;
}

/**
 * ある日の天体の出・南中・没を求める。
 * 見つからない場合 (周極・出没なし) は null が入る。
 * dayStart は「その日の始まり」の絶対時刻 (JST 0:00)。
 */
function riseSet(body, dayStart, lat, lon, target) {
  const altFn = altitudeFn(body, lat, lon);
  const dayEnd = dayStart + 86400000;
  const alt = target ?? (body === "sun" ? ALT_SUNRISE
    : body === "moon" ? ALT_MOONRISE : ALT_PLANET);

  const crossings = findCrossings(altFn, dayStart, dayEnd, alt);
  const rise = crossings.find((c) => c.rising)?.ms ?? null;
  const set = crossings.find((c) => !c.rising)?.ms ?? null;

  // 南中: 高度が最大になる時刻 (三分探索で十分)
  let lo = dayStart, hi = dayEnd;
  for (let i = 0; i < 60; i++) {
    const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
    if (altFn(m1) < altFn(m2)) lo = m1; else hi = m2;
  }
  const transit = Math.round((lo + hi) / 2);

  return {
    rise, set, transit,
    transitAlt: altFn(transit),
    alwaysUp: rise === null && set === null && altFn(dayStart) > alt,
    alwaysDown: rise === null && set === null && altFn(dayStart) <= alt,
  };
}

/** 薄明の時刻。夕方 (日没後) と朝 (日の出前) の各段階。 */
function twilightTimes(dayStart, lat, lon) {
  const altFn = altitudeFn("sun", lat, lon);
  const dayEnd = dayStart + 86400000;
  const result = {};
  for (const [name, alt] of Object.entries(TWILIGHT)) {
    const cs = findCrossings(altFn, dayStart, dayEnd, alt);
    result[name] = {
      dawn: cs.find((c) => c.rising)?.ms ?? null,   // 薄明のはじまり (朝)
      dusk: cs.find((c) => !c.rising)?.ms ?? null,  // 薄明のおわり (夕方)
    };
  }
  return result;
}

const SYNODIC = 29.530589; // 朔望月 [日]

/**
 * 月齢 [日]・輝面比・満ち欠けの向き。月齢は「直前の新月」からの経過日数。
 *
 * 太陽との離角の極小を探すと、新月の直前には「直後の新月」に食いついて
 * 月齢が負になってしまう。そこで黄経差 D = 月の黄経 − 太陽の黄経 を使う。
 * D は新月から次の新月にかけて 0° → 360° と単調に増えるので、
 * D = 0 の直前の解を素直に求められる。
 */
function moonAge(ms) {
  const jd = jdFromDate(new Date(ms));
  // 新月をまたぐと ±180° で折り返す符号つきの黄経差 (新月でちょうど 0 になる)
  const signedD = (j) =>
    ((norm360(moonPosition(j).lon - sunPosition(j).lon) + 180) % 360) - 180;
  const elapsed = norm360(moonPosition(jd).lon - sunPosition(jd).lon) / 360 * SYNODIC;

  // 直前の新月の見当をつけて、その前後 ±2日を二分法で詰める
  let lo = jd - elapsed - 2, hi = jd - elapsed + 2;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (signedD(mid) < 0) lo = mid; else hi = mid;
  }
  const newMoonJd = (lo + hi) / 2;

  return {
    age: jd - newMoonJd,
    illum: moonPhase(moonPosition(jd)).illum,
    waxing: norm360(moonPosition(jd).lon - sunPosition(jd).lon) < 180, // 満ちていく途中か
  };
}

/**
 * その夜に惑星が「見ごろ」になる時間帯。
 * 天文薄明の終わり〜始まり (= 完全な夜) のうち、高度が minAlt 以上にある区間を返す。
 * 夜が明るいうちしか出ていない惑星 (夕方の水星など) を取りこぼさないよう、
 * 市民薄明の終わりからを対象にする。
 */
function planetWindows(dayStart, lat, lon, minAlt = 15) {
  const tw = twilightTimes(dayStart, lat, lon);
  // 「今夜」= 当日の市民薄明の終わり 〜 翌日の市民薄明の始まり
  const nightFrom = tw.civil.dusk ?? dayStart + 18 * 3600e3;
  const nextTw = twilightTimes(dayStart + 86400000, lat, lon);
  const nightTo = nextTw.civil.dawn ?? dayStart + 30 * 3600e3;

  const out = [];
  for (const [name, ja] of PLANET_NAMES) {
    const altFn = altitudeFn(name, lat, lon);
    const cs = findCrossings(altFn, nightFrom, nightTo, minAlt, 5 * 60000);
    let from = altFn(nightFrom) >= minAlt ? nightFrom : null;
    const spans = [];
    for (const c of cs) {
      if (c.rising) from = c.ms;
      else if (from !== null) { spans.push([from, c.ms]); from = null; }
    }
    if (from !== null) spans.push([from, nightTo]);
    if (!spans.length) continue;

    // 最高高度の瞬間 (見ごろの中心)
    const best = spans.reduce((a, b) =>
      (altFn((a[0] + a[1]) / 2) > altFn((b[0] + b[1]) / 2) ? a : b));
    const bestMs = (best[0] + best[1]) / 2;
    const jd = jdFromDate(new Date(bestMs));
    out.push({
      name, ja, spans,
      bestMs,
      bestAlt: altFn(bestMs),
      mag: planetPosition(name, jd).mag,
    });
  }
  return { nightFrom, nightTo, planets: out };
}

const PLANET_NAMES = [
  ["Mercury", "水星"], ["Venus", "金星"], ["Mars", "火星"],
  ["Jupiter", "木星"], ["Saturn", "土星"],
];

// ---------------- 天文現象 (カレンダー用) ----------------

/**
 * 太陽黄経 λ☉ を J2000.0 分点で返す [度]。
 * 流星群の極大は λ☉ (J2000.0) で公表されるので、日付の分点で計算した黄経から
 * 一般歳差 (約 50.3″/年) を差し引く。2026年で 0.36°、時間にして約9時間ぶんの差になる。
 */
function sunLongitudeJ2000(jd) {
  const T = (jd - 2451545.0) / 36525.0;
  const precession = 1.396971 * T + 0.0003086 * T * T; // Meeus 21章の一般歳差 [度]
  return norm360(sunPosition(jd).lon - precession);
}

/** ある年に太陽黄経 (J2000) が lambda になる瞬間を求める。 */
function solarLongitudeTime(year, lambda) {
  const start = julianDay(year, 1, 1);
  // λ☉ は 1年で 0→360° と一周するので、日単位で走査して交差を捕まえる
  const diff = (jd) => {
    const d = norm360(sunLongitudeJ2000(jd) - lambda);
    return d > 180 ? d - 360 : d;   // −180〜+180 に畳む (λ の直前が負、直後が正)
  };
  let lo = start, dlo = diff(lo);
  for (let d = 1; d <= 366; d++) {
    const hi = start + d, dhi = diff(hi);
    if (dlo < 0 && dhi >= 0) {                 // 目標の黄経をまたいだ
      let a = lo, b = hi;
      for (let i = 0; i < 40; i++) {           // 二分法で1分未満まで詰める
        const mid = (a + b) / 2;
        if (diff(mid) < 0) a = mid; else b = mid;
      }
      return dateFromJd((a + b) / 2);
    }
    lo = hi; dlo = dhi;
  }
  return null;
}

/** ユリウス日 → 絶対時刻 [ms]。 */
function dateFromJd(jd) {
  return Math.round((jd - 2440587.5) * 86400000);
}

/** その年の流星群の極大 (λ☉ から計算)。 */
function meteorPeaks(year) {
  return METEOR_SHOWERS.map(([name, lam, zhr, ra, dec, note]) => ({
    name, zhr, ra, dec, note,
    peakMs: solarLongitudeTime(year, lam),
  })).filter((m) => m.peakMs !== null).sort((a, b) => a.peakMs - b.peakMs);
}

/** 月と太陽の黄経差 [度] (0=新月, 90=上弦, 180=満月, 270=下弦)。 */
function moonSunLon(jd) {
  return norm360(moonPosition(jd).lon - sunPosition(jd).lon);
}

/** 期間内の月相 (新月・上弦・満月・下弦) を返す。 */
function moonPhaseEvents(fromMs, toMs) {
  const PHASES = [[0, "新月"], [90, "上弦"], [180, "満月"], [270, "下弦"]];
  const out = [];
  const fromJd = jdFromDate(new Date(fromMs)), toJd = jdFromDate(new Date(toMs));

  for (const [target, name] of PHASES) {
    // 目標の黄経差からの差を −180〜+180 に畳むと、月相の瞬間で符号が変わる
    const f = (jd) => {
      const d = norm360(moonSunLon(jd) - target);
      return d > 180 ? d - 360 : d;
    };
    let lo = fromJd, flo = f(lo);
    for (let jd = fromJd + 0.5; jd <= toJd; jd += 0.5) {
      const fhi = f(jd);
      if (flo < 0 && fhi >= 0) {
        let a = lo, b = jd;
        for (let i = 0; i < 40; i++) {
          const mid = (a + b) / 2;
          if (f(mid) < 0) a = mid; else b = mid;
        }
        out.push({ name, ms: dateFromJd((a + b) / 2) });
      }
      lo = jd; flo = fhi;
    }
  }
  return out.sort((a, b) => a.ms - b.ms);
}

/**
 * 期間内の惑星の現象 (衝・合・最大離角)。
 * 太陽との離角を日単位で走査して極値を拾い、三分探索で詰める。
 * 「留」は視赤経の停留を見るもので、うちの精度では日付が数日ぶれるので出さない。
 */
function planetEvents(fromMs, toMs) {
  const INNER = new Set(["Mercury", "Venus"]);
  const out = [];

  for (const [name, ja] of PLANET_NAMES) {
    const elong = (jd) => {
      const sun = sunPosition(jd);
      const p = planetPosition(name, jd);
      return angularSep(sun.ra, sun.dec, p.ra, p.dec);
    };
    const fromJd = Math.floor(jdFromDate(new Date(fromMs)));
    const toJd = Math.ceil(jdFromDate(new Date(toMs)));

    let prev = elong(fromJd - 1), cur = elong(fromJd);
    for (let jd = fromJd + 1; jd <= toJd; jd++) {
      const next = elong(jd);
      const isMax = cur > prev && cur > next;
      const isMin = cur < prev && cur < next;
      if (isMax || isMin) {
        const at = extremum(elong, jd - 2, jd, isMax);
        const e = elong(at);
        const p = planetPosition(name, at);
        let label;
        if (isMax) {
          // 太陽より赤経が進んでいれば東方 (夕方の西空)、遅れていれば西方 (明け方の東空)
          const east = norm360(p.ra - sunPosition(at).ra) < 180;
          label = INNER.has(name)
            ? `${east ? "東方" : "西方"}最大離角 (${e.toFixed(0)}°) — ${east ? "夕方の西空" : "明け方の東空"}`
            : "衝 (一晩中見える)";
        } else {
          label = INNER.has(name)
            ? (p.R < 1 ? "内合 (太陽の手前)" : "外合 (太陽の向こう)")
            : "合 (太陽の方向)";
        }
        out.push({ name, ja, ms: dateFromJd(at), label, elong: e, mag: p.mag });
      }
      prev = cur; cur = next;
    }
  }
  return out.filter((e) => e.ms >= fromMs && e.ms <= toMs).sort((a, b) => a.ms - b.ms);
}

/** 2点の離角 [度]。 */
function angularSep(ra1, dec1, ra2, dec2) {
  const c = Math.sin(dec1 * DEG) * Math.sin(dec2 * DEG)
    + Math.cos(dec1 * DEG) * Math.cos(dec2 * DEG) * Math.cos((ra1 - ra2) * DEG);
  return Math.acos(Math.max(-1, Math.min(1, c))) * RAD;
}

/** 三分探索で極値の位置を求める。 */
function extremum(f, lo, hi, wantMax) {
  for (let i = 0; i < 50; i++) {
    const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
    const better = wantMax ? f(m1) < f(m2) : f(m1) > f(m2);
    if (better) lo = m1; else hi = m2;
  }
  return (lo + hi) / 2;
}

/**
 * 月食が観測地から見えるか。月食は地心現象なので、欠けている間に
 * 月が地平線の上にいるかどうかだけで決まる。
 * eclipse = ECLIPSES_LUNAR の1行、返り値は月の高度など。
 */
function lunarEclipseLocal(eclipse, lat, lon) {
  const [date, timeUt] = eclipse;
  const [y, mo, d] = date.split("-").map(Number);
  const [hh, mm, ss] = timeUt.split(":").map(Number);
  const ms = Date.UTC(y, mo - 1, d, hh, mm, ss);
  const jd = jdFromDate(new Date(ms));
  const moon = moonTopocentric(moonPosition(jd), jd, lat, lon);
  const { alt, az } = eqToHorizon(moon.ra, moon.dec, jd, lat, lon, false);
  const sunAlt = (() => {
    const s = sunPosition(jd);
    return eqToHorizon(s.ra, s.dec, jd, lat, lon, false).alt;
  })();
  return {
    ms, alt, az,
    visible: alt > 0,          // 食の最大の瞬間に月が出ているか
    daylight: sunAlt > -6,     // 空が明るいと見えづらい
  };
}

