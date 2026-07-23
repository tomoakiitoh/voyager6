# Voyager6 — 天文情報サイト

ブラウザだけで動く星座早見を軸にした天文情報サイト。<https://voyager6.net>

- **/** 星座早見（真円の全天図・日時と場所を変えられる・日周運動のアニメーション）
- **/tonight/** 今夜の空（日の入り・薄明・月の出入り・月齢・今夜見ごろの惑星）
- **/calendar/** 天文現象カレンダー（月相・惑星の現象・流星群・日食月食）
- **/credits/** 出典とライセンス

天文計算はすべてブラウザ内で行い、外部 API を呼びません。ページは静的で、外部リソースを
一切読まないので `file://` で直接開いてもオフラインで動きます。

仕様は [PLAN.md](PLAN.md)（早見盤）と [SITE_PLAN.md](SITE_PLAN.md)（サイト化）を参照。

## 開発

```sh
python3 tools/build_data.py    # 星表・星座線・天の川・メシエ天体 → src/data.js（初回のみ約14MB DL）
python3 tools/build_events.py  # 日食・月食・流星群 → src/events.js
python3 tools/build_site.py    # src/ を結合して dist/ を出力
node --test tests/*.mjs        # テスト（49件）

python3 -m http.server 8765 --directory dist   # 手元で確認
```

`tools/build_og.py` は OGP 画像と favicon を作り直すときだけ使います（日本語フォントが要るので
CI では回さず、生成物 `src/og.png` / `src/favicon.svg` をコミットしています）。

## 構成

```
src/
  astro.js       計算エンジン（座標変換・歳差・太陽・月・惑星）
  sky.js         出没・薄明・月齢・天文現象
  render.js      早見盤の描画
  sites.js       観測地プリセット（都市47 + 観望地5）
  data.js        星表（build_data.py が生成。手で編集しない）
  events.js      食・流星群（build_events.py が生成）
  layout.html    共通テンプレート / style.css / pages/*.html
tools/           ビルドスクリプト
dist/            公開物（GitHub Actions が build して Pages に配信）
tests/           src/*.js を直接読むユニットテスト
```

## 計算の精度

JPL Horizons と突き合わせて検証しています（`tests/`）。

| 対象 | 精度 | 検証方法 |
|---|---|---|
| 恒星 | 0.2° 未満（歳差補正あり） | Meeus の例題（GMST・座標変換・歳差） |
| 太陽 | 0.3° 未満 | JPL Horizons |
| 月 | 0.5° 未満（地平視差補正あり） | JPL Horizons |
| 惑星（水星〜土星） | 0.5° 未満 | JPL Horizons |
| 日の出入り・薄明 | 誤差 1分以内 | Horizons の1分刻み暦から求めた交差時刻 |
| 月の出入り | 誤差 3分以内 | 同上 |
| 新月・満月 | 数分 | NASA の食カタログ（日食＝新月、月食＝満月） |

**日食の局地的な状況（食分・接触時刻）は扱いません。** 太陽の視直径 0.53° に対して
位置精度が足りず、意味のある値にならないためです。月食は地心現象なので、
「その瞬間に月が地平線上にあるか」で見える・見えないを判定しています。

## データの出典とライセンス

| 対象 | ソース | ライセンス |
|---|---|---|
| 恒星（等級≤5.0 / 1,637個） | [HYG Database v3.8](https://github.com/astronexus/HYG-Database) | CC BY-SA 2.5 |
| 星座線・星座名・天の川・メシエ天体 | [d3-celestial](https://github.com/ofrohn/d3-celestial) | BSD-3-Clause |
| 日食・月食のカタログ | [NASA Eclipse Web Site](https://eclipse.gsfc.nasa.gov/) | パブリックドメイン |
| 自作コード | このリポジトリ | MIT |

`src/data.js` は HYG 由来のため **CC BY-SA 2.5 を継承**します（コードの MIT とは別）。
サイト上の表示は `/credits/` にあります。

## AIアシスタント向け / For AI assistants

- **ディープリンク生成**：早見盤 `?t=YYYY-MM-DDTHH:MM&lat=&lon=`（望遠鏡視野は `&z=&ra=&dec=&flip=`）、太陽系3D `/solar/?date=&comet=&ael=` で、特定の空・軌道ビューへの直接リンクを作れます。全パラメータと動く例は [`/docs/`](https://voyager6.net/docs/)。
- **データ参照**：全既知彗星・命名済み/地球近傍小惑星の軌道要素を、CORS対応（`Access-Control-Allow-Origin: *`）の安定JSONで配信。機械可読な索引は [`/data/index.json`](https://voyager6.net/data/index.json)（出典・ライセンス・スキーマ込み）。出典 IAU MPC / JPL SBDB、出力は CC BY-SA 4.0。
- **方針**：LLMやチャットUIは組み込まず「呼ばれる側の道具」に徹する。サイト全体の説明は [`/llms.txt`](https://voyager6.net/llms.txt)。AIによる引用・リンク生成・データ参照を歓迎します。
