// シネマティック撮影ループ。/solar/?cine=1&tier2=1 を開いた状態でこの中身を実行する
// (Claude-in-Chrome / DevTools コンソール)。frames/ に f0000.png… と title/caption を保存する。
// カメラは原点(太陽)注視の球座標: caz=方位[deg], cel=高度[deg], cdist=距離[AU]。
(async () => {
  const cv = document.getElementById("solar-canvas");
  const post = (body, qs) => fetch(`/__frame?${qs}`, { method: "POST", headers: { "Content-Type": "text/plain" }, body });
  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth = (t) => t * t * (3 - 2 * t);
  // キーフレーム: [t, cel, cdist, caz, dJd(日)]
  const KEYS = [
    [0.00, 18, 40, -25,   0],
    [0.12, 20, 38, -18,  30],
    [0.55, 62, 15,  10, 380],
    [0.78, 66, 12,  25, 600],
    [1.00, 64, 12.5, 45, 760],
  ];
  const sample = (t) => {
    let a = KEYS[0], b = KEYS[KEYS.length - 1];
    for (let i = 0; i + 1 < KEYS.length; i++) if (t >= KEYS[i][0] && t <= KEYS[i + 1][0]) { a = KEYS[i]; b = KEYS[i + 1]; break; }
    const u = smooth((t - a[0]) / Math.max(1e-6, b[0] - a[0]));
    return { cel: lerp(a[1], b[1], u), cdist: lerp(a[2], b[2], u), caz: lerp(a[3], b[3], u), dJd: lerp(a[4], b[4], u) };
  };

  // --- タイトル / 字幕を 2Dキャンバスで生成 (日本語はブラウザのフォントで確実に描ける) ---
  function card(draw) {
    const c = document.createElement("canvas"); c.width = 1280; c.height = 720;
    const g = c.getContext("2d"); draw(g, c); return c.toDataURL("image/png");
  }
  const title = card((g) => {
    g.fillStyle = "#05070d"; g.fillRect(0, 0, 1280, 720);
    g.textAlign = "center"; g.fillStyle = "#eaf0ff";
    g.font = "600 66px 'Hiragino Kaku Gothic ProN',sans-serif";
    g.fillText("トロヤ群への旅", 640, 360);
    g.fillStyle = "#6ea8ff"; g.font = "600 20px 'Hiragino Kaku Gothic ProN',sans-serif";
    g.fillText("VOYAGER6 ・ 太陽系3D", 640, 410);
  });
  const caption = card((g) => {
    g.clearRect(0, 0, 1280, 720);
    g.textAlign = "center";
    g.font = "600 34px 'Hiragino Kaku Gothic ProN',sans-serif";
    g.lineWidth = 6; g.strokeStyle = "rgba(0,0,0,.7)"; g.fillStyle = "#eaf0ff";
    const msg = "回転座標系で L4・L5 に小惑星トロヤ群が浮かぶ";
    g.strokeText(msg, 640, 660); g.fillText(msg, 640, 660);
  });
  await post(title, "name=title.png");
  await post(caption, "name=caption.png");

  // --- 本編フレーム ---
  const N = 168, jd0 = 2461230;
  await new Promise((r) => setTimeout(r, 3000)); // tier2 ロード待ち
  for (let i = 0; i < N; i++) {
    const s = sample(i / (N - 1));
    window.cineRender({ jd: jd0 + s.dJd, corot: 1, tier2: 1, orbits: 1, comets: 0, names: 0, caz: s.caz, cel: s.cel, cdist: s.cdist });
    await post(cv.toDataURL("image/png"), `i=${i}`);
  }
  console.log("[cine] captured", N, "frames + title/caption");
})();
