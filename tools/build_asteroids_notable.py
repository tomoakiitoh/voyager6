#!/usr/bin/env python3
"""著名小惑星リスト (探査機が訪れた/向かう小惑星) を生成する (PLAN5 F7)。

    python3 tools/build_asteroids_notable.py

小天体DBハブ (PLAN5) の「著名小惑星」= 作者監修の編集コンテンツ。探査機ミッションの
対象になった小惑星を軸に、番号・和名・探査機・年・一言メモを人手で並べる (自動生成しない)。
軌道要素・H・直径・分類は asteroids_catalog.json (SBDB由来) から番号一致で引いて結合する。

出力 src/asteroids_notable.json = JSON 配列、1件 = dict:
  num       小惑星番号
  name_en   英名 (カタログ由来)
  name_ja   和名
  craft     探査機 (運用機関)
  year      訪問/回収 or 予定の年
  note      一言メモ
  planned   True=これから (予定/接近)
  class     軌道分類 (MBA/APO/… )
  H, diameter, elements=[a,e,i,Ω,ω,M0,epoch]  ← 3Dで軌道・現在位置を描くため

注意: craft/year/note は事実ベースだが、収録範囲・表現は作者が確定してよい (監修余地)。
出典: 軌道要素は JPL SBDB (asteroids_catalog.json 経由)。
"""

from __future__ import annotations

import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent
CATALOG = ROOT.parent / "src" / "asteroids_catalog.json"
OUT = ROOT.parent / "src" / "asteroids_notable.json"

# (番号, 和名, 探査機, 年, 予定か, メモ) —— 訪問順・時代順にだいたい並べる
NOTABLE = [
    (951, "ガスプラ", "ガリレオ (NASA)", "1991", False, "史上初めて探査機が接近した小惑星。"),
    (243, "イダ", "ガリレオ (NASA)", "1993", False, "初めて衛星 (ダクティル) が見つかった小惑星。"),
    (253, "マチルデ", "NEAR (NASA)", "1997", False, "非常に黒い炭素質。低密度でスカスカ。"),
    (9969, "ブライユ", "ディープ・スペース1 (NASA)", "1999", False, "イオンエンジン実証機が接近。"),
    (433, "エロス", "NEAR シューメーカー (NASA)", "2000–2001", False,
     "初めて小惑星を周回し、最後は着陸。代表的な地球近傍小惑星。"),
    (5535, "アンネフランク", "スターダスト (NASA)", "2002", False, "彗星探査の途上でフライバイ。"),
    (25143, "イトカワ", "はやぶさ (JAXA)", "2005 訪問 / 2010 試料回収", False,
     "世界初の小惑星サンプルリターン。ラッコ形の“ラブルパイル”。"),
    (2867, "シュテインス", "ロゼッタ (ESA)", "2008", False, "ダイヤモンド形のE型小惑星。"),
    (21, "ルテティア", "ロゼッタ (ESA)", "2010", False, "当時フライバイした最大級の小惑星。"),
    (4, "ベスタ", "ドーン (NASA)", "2011–2012", False, "巨大クレーターと明暗模様。準惑星に次ぐ大きさ。"),
    (4179, "トータティス", "嫦娥2号 (CNSC)", "2012", False, "細長く不規則な地球近傍小惑星。"),
    (1, "ケレス", "ドーン (NASA)", "2015–2018", False, "小惑星帯で唯一の準惑星。謎の明るい斑点。"),
    (162173, "リュウグウ", "はやぶさ2 (JAXA)", "2018 訪問 / 2020 試料回収", False,
     "そろばん玉形。人工クレーター実験と2度の着陸で試料回収。"),
    (101955, "ベンヌ", "オサイリス・レックス (NASA)", "2018 訪問 / 2023 試料回収", False,
     "触れて試料採取。将来の地球接近が注目される潜在的危険小惑星。"),
    (65803, "ディディモス", "DART (NASA)", "2022 衝突", False,
     "衛星ディモルフォスに探査機を意図的に衝突させ、軌道を変えた planetary defense 実験。"),
    (152830, "ディンキネシュ", "ルーシー (NASA)", "2023", False,
     "小さな衛星 (セラム) が“接触二重星”という珍しい姿だった。"),
    (52246, "ドナルドジョハンソン", "ルーシー (NASA)", "2025", False, "ルーシーのメインベルト通過中の目標。"),
    (3200, "ファエトン", "DESTINY+ (JAXA)", "2028 頃 予定", True,
     "ふたご座流星群の母天体。日本の DESTINY+ が目指す。太陽に非常に近づく。"),
    (99942, "アポフィス", "OSIRIS-APEX (NASA)", "2029 接近 予定", True,
     "2029年4月13日に地球へ肉眼等級で大接近。探査機が接近後を観測予定。"),
    (617, "パトロクロス", "ルーシー (NASA)", "2033 予定", True,
     "木星トロヤ群 (L5) の二重小惑星。ルーシー計画の最終目標。"),
]


def main() -> int:
    catalog = json.loads(CATALOG.read_text(encoding="utf-8"))
    # asteroids_catalog 1件 = [num,name,pdes,class,a,e,i,Ω,ω,M0,epoch,H,diam]
    by_num = {r[0]: r for r in catalog if r[0] is not None}

    out, missing = [], []
    for num, ja, craft, year, planned, note in NOTABLE:
        r = by_num.get(num)
        if not r:
            missing.append(num)
            continue
        out.append({
            "num": num, "name_en": r[1], "name_ja": ja,
            "craft": craft, "year": year, "planned": planned, "note": note,
            "class": r[3], "H": r[11], "diameter": r[12],
            "elements": [r[4], r[5], r[6], r[7], r[8], r[9], r[10]],  # a,e,i,Ω,ω,M0,epoch
        })

    if missing:
        print(f"  ! カタログに見つからない番号: {missing}", file=sys.stderr)
    if len(out) < 10:
        print(f"エラー: 著名小惑星が {len(out)} 件しか作れず異常。中止。", file=sys.stderr)
        return 1

    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    visited = sum(1 for r in out if not r["planned"])
    print(f"  asteroids_notable.json: {len(out)} 件 (訪問済み {visited} / 予定 {len(out) - visited}) "
          f"({OUT.stat().st_size:,} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
