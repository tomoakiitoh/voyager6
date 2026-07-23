# シネマティック撮影 (PLAN4 §4)

太陽系3D (/solar/) の実描画を1フレームずつ書き出し、ffmpeg で動画にする。
**ショットJSONを書いて1コマンド**で mp4 が出る（GPU不要・完全自動）。

## 無人レンダラ（推奨）
```
python3 tools/build_site.py                       # dist を作る (?cine=1 対応版)
node tools/cine/render.mjs tools/cine/shots/trojan_journey.json
# -> tools/cine/<name>.mp4
```
- 内蔵の静的サーバで dist を配り、システムChromeをヘッドレス(SwiftShader)で駆動。
- `?cine=1` の描画モード + `window.cineRender()` を毎フレーム呼んでキャプチャ→ffmpeg。
- 依存: `npm i`（puppeteer-core）。Chrome は /Applications の Google Chrome を使用。

## ショットJSON スキーマ（＝動画の"台本"）
```jsonc
{
  "name": "trojan_journey",           // 出力ファイル名
  "fps": 24, "seconds": 7,            // フレームレートと本編尺
  "jd0": 2461230,                    // 基準ユリウス日
  "resolution": [1280, 720],
  "layers": { "corot":1,"tier2":1,"orbits":1,"comets":0,"ast1":0,"names":0 },
  "title":   { "text":"…","sub":"…","seconds":1.6 },   // 省略可
  "caption": { "text":"…","in":4.3,"out":6.3 },         // 省略可 (秒。本編内の時刻)
  "camera": [                        // キーフレーム (t=0→1 で補間)
    { "t":0.0, "cel":18, "cdist":40, "caz":-25, "dJd":0 },   // cel=高度° cdist=距離AU
    { "t":1.0, "cel":64, "cdist":12.5,"caz":45, "dJd":760 }  // caz=方位° dJd=経過日数
  ]
}
```
カメラは原点(太陽)注視の球座標。co-rotate ON で時間(dJd)を進めるとメインベルトが流れ、
トロヤ群だけ静止＝リビールになる。**この台本を差し替えれば別の1本**（自然言語→JSON→動画の土台）。

## 手動版（デバッグ用）
`tools/cine/serve.py` を起動 → ブラウザで `/solar/?cine=1` → `tools/cine/capture.js` を実行 → `build.sh`。

## 注意
- 彗星の軌道線 (`cometOrbits:1`) を多数(数百本〜)表示するとヘッドレスのSwiftShaderが
  コンテキストを失い真っ白になることがある。無人レンダでは点群主体にするか、群を絞る。

## 未対応（今後）
- レンダ後のフレームを LLM に戻して批評→自己修正するレビュー枠。
- 追尾カメラ（彗星を追う等）、複数ショット連結、ナレーション/BGM、CI定期生成。
