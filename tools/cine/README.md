# シネマティック撮影 (PLAN4 §4)

太陽系3D (/solar/) の実描画を1フレームずつ書き出し、ffmpeg で動画にする。

## 流れ
1. `python3 tools/build_site.py` で dist を作る（solar.html に `?cine=1` の描画モードが要る）。
2. `python3 tools/cine/serve.py` を起動（http://127.0.0.1:8754、POST /__frame を frames/ に保存）。
3. ブラウザで `http://127.0.0.1:8754/solar/?cine=1&tier2=1&corot=1&orbits=1&jd=2461230&caz=-25&cel=18&cdist=40` を開く。
4. `tools/cine/capture.js` の中身を DevTools コンソールで実行 → frames/ に f0000.png… と title/caption が溜まる。
5. `tools/cine/build.sh` → `tools/cine/trojan_journey.mp4`。

## しくみ
- `?cine=1`：UI非表示・固定1280×720・スクリプト視点（OrbitControls/リサイズ/URL書戻し停止）。
- `window.cineRender({jd,caz,cel,cdist,corot,tier2,orbits,comets,names})`：1枚描画。
  カメラは原点(太陽)注視の球座標（caz=方位, cel=高度, cdist=距離[AU]）。
- 捕獲は `canvas.toDataURL`（描画直後に同期呼び）→ ローカルサーバへ POST。
- タイトル/字幕は 2Dキャンバスで生成（日本語フォント）→ ffmpeg で fade/overlay/concat。

## 未対応（今後）
- 無人化（Playwright/puppeteer で load-once→loop）。現状は実ブラウザを手動/半自動で駆動。
- ナレーション・BGM、複数ショットの連結、CI 定期生成。
