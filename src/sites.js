"use strict";

/**
 * 観測地プリセット。[名前, 緯度, 経度]。
 * 座標は各都市の市役所・県庁付近。星の位置は 0.01° = 約1km の違いでは動かないので
 * この粒度で十分 (月の地平視差だけがわずかに効くが、出没時刻で数秒のオーダー)。
 */
const SITES_PREF = [
  ["札幌", 43.06, 141.35], ["青森", 40.82, 140.74], ["盛岡", 39.70, 141.15],
  ["仙台", 38.27, 140.87], ["秋田", 39.72, 140.10], ["山形", 38.24, 140.36],
  ["福島", 37.75, 140.47], ["水戸", 36.34, 140.45], ["宇都宮", 36.57, 139.88],
  ["前橋", 36.39, 139.06], ["さいたま", 35.86, 139.65], ["千葉", 35.61, 140.12],
  ["東京", 35.68, 139.77], ["横浜", 35.45, 139.64], ["新潟", 37.90, 139.02],
  ["富山", 36.70, 137.21], ["金沢", 36.59, 136.63], ["福井", 36.07, 136.22],
  ["甲府", 35.66, 138.57], ["長野", 36.65, 138.18], ["岐阜", 35.39, 136.72],
  ["静岡", 34.98, 138.38], ["名古屋", 35.18, 136.91], ["津", 34.73, 136.51],
  ["大津", 35.00, 135.87], ["京都", 35.02, 135.76], ["大阪", 34.69, 135.52],
  ["神戸", 34.69, 135.20], ["奈良", 34.69, 135.83], ["和歌山", 34.23, 135.17],
  ["鳥取", 35.50, 134.24], ["松江", 35.47, 133.05], ["岡山", 34.66, 133.93],
  ["広島", 34.40, 132.46], ["山口", 34.19, 131.47], ["徳島", 34.07, 134.56],
  ["高松", 34.34, 134.04], ["松山", 33.84, 132.77], ["高知", 33.56, 133.53],
  ["福岡", 33.61, 130.42], ["佐賀", 33.25, 130.30], ["長崎", 32.74, 129.87],
  ["熊本", 32.79, 130.74], ["大分", 33.24, 131.61], ["宮崎", 31.91, 131.42],
  ["鹿児島", 31.56, 130.56], ["那覇", 26.21, 127.68],
];

/** 観望地として名の通った場所。 */
const SITES_SPOT = [
  ["野辺山 (南牧村)", 35.94, 138.48],
  ["富士山五合目", 35.39, 138.73],
  ["乗鞍高原", 36.11, 137.62],
  ["石垣島", 24.34, 124.16],
  ["父島 (小笠原)", 27.09, 142.19],
];

const SITE_GROUPS = [
  ["都市", SITES_PREF],
  ["観望地", SITES_SPOT],
];

const DEFAULT_SITE = { name: "東京", lat: 35.68, lon: 139.77 };

/** 保存してある観測地を読む (なければ東京)。 */
function loadSite() {
  try {
    const s = JSON.parse(localStorage.getItem("site"));
    if (s && Number.isFinite(s.lat) && Number.isFinite(s.lon)) return s;
  } catch (e) { /* 壊れていたら既定値に戻す */ }
  return { ...DEFAULT_SITE };
}

function saveSite(site) {
  try {
    localStorage.setItem("site", JSON.stringify(site));
  } catch (e) { /* プライベートモードなどで保存できなくても動作は続ける */ }
}

/** <select> に観測地の選択肢を並べる。 */
function fillSiteSelect(sel, current) {
  sel.innerHTML = "";
  for (const [label, list] of SITE_GROUPS) {
    const g = document.createElement("optgroup");
    g.label = label;
    for (const [name, lat, lon] of list) {
      const o = document.createElement("option");
      o.value = `${lat},${lon}`;
      o.textContent = name;
      o.selected = name === current.name;
      g.appendChild(o);
    }
    sel.appendChild(g);
  }
  const custom = document.createElement("option");
  custom.value = "custom";
  custom.textContent = "そのほか (緯度経度を入力)";
  custom.selected = !SITE_GROUPS.some(([, l]) => l.some(([n]) => n === current.name));
  sel.appendChild(custom);
}
