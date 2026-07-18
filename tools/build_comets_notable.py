#!/usr/bin/env python3
"""著名彗星リスト (肉眼彗星の仮置き) を生成する (PLAN5 F2/F6 の土台)。

    python3 tools/build_comets_notable.py

小天体DBハブ (PLAN5) の「肉眼彗星リスト」用データ。設計上ここは *作者監修の編集コンテンツ*
なので、本スクリプトが作るのは **監修前の仮置き (skeleton)**。客観的に決まる結合データ
(符号・英名・近日点通過日・軌道要素) を埋め、編集項目 (最大光度 max_mag・一言メモ note) は
作者が後で確定する前提のプレースホルダにする。

軌道要素は既存 comets_all.json (MPC+SBDB) から符号一致で拾い、無いものだけ JPL SBDB の
lookup API (sbdb.api) から取得する。歴史的彗星は接触要素による概略表示 (但し書き踏襲)。

出力 src/comets_notable.json = JSON 配列、1件 = dict:
  desig     主符号 (例 "C/1996 B2", "1P")
  name_en   英名 (カタログ由来)
  name_ja   和名 (定訳。客観)
  max_mag   最大光度の目安 [仮置き。作者監修で確定]
  best_date 最良観測期の目安日 [仮置き。既定は近日点通過日]
  note      一言メモ [空 = 作者記入待ち]
  peri_jd   近日点通過 [JD]
  elements  [e, q, i, Ω, ω, Tp(JD)] 描画用 (無ければ null)
  source    "comets_all" | "sbdb" | "none"

出典: JPL Small-Body Database。max_mag/note は作者監修で確定するまで暫定値。
"""

from __future__ import annotations

import json
import math
import pathlib
import re
import sys
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent
ALL = ROOT.parent / "src" / "comets_all.json"
OUT = ROOT.parent / "src" / "comets_notable.json"
SBDB_LOOKUP = "https://ssd-api.jpl.nasa.gov/sbdb.api"

# 監修前の仮置きリスト (20世紀以降の代表的な肉眼彗星)。
# 各 dict: desig=表示符号, ja=和名, mag=最大光度[仮], best=著名な出現の日付[任意・上書き],
#          lookup=SBDB照会符号[任意。分裂彗星などで表示符号と異なる場合]。
# 周期彗星は接触要素が最新元期なので、著名な出現年 (ハレー1986/ホームズ2007) を best で明示する。
# max_mag と note は作者が後で確定する。
NOTABLE = [
    {"desig": "C/1965 S1", "ja": "池谷・関",     "mag": -10.0, "lookup": "C/1965 S1-A",
     "best": "1965-10-21"},                                   # 白昼彗星。クロイツ群 (主片S1-A)
    {"desig": "C/1969 Y1", "ja": "ベネット",       "mag": 0.0},
    {"desig": "C/1975 V1", "ja": "ウェスト",       "mag": -3.0},
    {"desig": "1P",        "ja": "ハレー",         "mag": 2.1, "best": "1986-02-09"},  # 1986年の出現
    {"desig": "C/1996 B2", "ja": "百武",          "mag": 0.0, "best": "1996-03-25"},  # 地球接近・尾が長大
    {"desig": "C/1995 O1", "ja": "ヘール・ボップ",  "mag": -1.0},  # 数か月見えた大彗星
    {"desig": "C/2002 C1", "ja": "池谷・張",       "mag": 3.0},
    {"desig": "17P",       "ja": "ホームズ",       "mag": 2.8, "best": "2007-10-24"},  # 2007大バースト
    {"desig": "C/2006 P1", "ja": "マックノート",    "mag": -5.0},  # 南天の大彗星
    {"desig": "C/2011 W3", "ja": "ラブジョイ",     "mag": -4.0},  # クロイツ群サングレーザー
    {"desig": "C/2020 F3", "ja": "ネオワイズ",      "mag": 1.0},
    {"desig": "C/2023 A3", "ja": "紫金山・ATLAS",   "mag": 0.0},
]


def desig_key(s: str) -> str:
    s = s.strip()
    m = re.match(r"^(\d+[PDI])\b", s)
    if m:
        return m.group(1)
    m = re.match(r"^([CPXAI]/\d{4}\s+[A-Z]{1,2}\d*(?:-[A-Z])?)", s)
    if m:
        return re.sub(r"\s+", " ", m.group(1))
    return s.split(" (")[0].strip()


def jd_to_ymd(jd: float) -> str:
    """JD → 'YYYY-MM-DD' (近日点日の目安表示用)。"""
    z = math.floor(jd + 0.5)
    a = z
    if z >= 2299161:
        al = math.floor((z - 1867216.25) / 36524.25)
        a = z + 1 + al - al // 4
    b = a + 1524
    c = math.floor((b - 122.1) / 365.25)
    d = math.floor(365.25 * c)
    e = math.floor((b - d) / 30.6001)
    day = b - d - math.floor(30.6001 * e)
    mon = e - 1 if e < 14 else e - 13
    year = c - 4716 if mon > 2 else c - 4715
    return f"{year:04d}-{mon:02d}-{day:02d}"


def fetch_sbdb(desig: str):
    """SBDB lookup で [name_en, e, q, i, Ω, ω, Tp] を返す。引けなければ None。"""
    try:
        url = f"{SBDB_LOOKUP}?" + urllib.parse.urlencode({"sstr": desig})
        req = urllib.request.Request(url, headers={"User-Agent": "voyager6-build"})
        with urllib.request.urlopen(req, timeout=60) as res:
            d = json.load(res)
        name_en = d.get("object", {}).get("fullname", desig)
        el = {e["name"]: e["value"] for e in d["orbit"]["elements"]}
        return name_en, [float(el["e"]), float(el["q"]), float(el["i"]),
                         float(el["om"]), float(el["w"]), float(el["tp"])]
    except Exception as e:  # noqa: BLE001
        print(f"  ! SBDB lookup 失敗 {desig} ({e})", file=sys.stderr)
        return None


def main() -> int:
    all_comets = json.loads(ALL.read_text(encoding="utf-8"))
    idx = {}
    for c in all_comets:  # [name,e,q,i,node,peri,tp,M1,K1]
        idx.setdefault(desig_key(c[0]), c)

    out, missing = [], 0
    for item in NOTABLE:
        desig, name_ja, max_mag = item["desig"], item["ja"], item["mag"]
        rec = {"desig": desig, "name_ja": name_ja, "max_mag": max_mag,
               "note": "", "source": "none", "elements": None,
               "peri_jd": None, "best_date": None, "name_en": desig}
        c = idx.get(desig_key(desig))
        if c:
            rec["name_en"] = re.sub(r"\s*\(.*\)$", "", c[0]).strip()
            rec["elements"] = [c[1], c[2], c[3], c[4], c[5], c[6]]
            rec["peri_jd"] = c[6]
            rec["source"] = "comets_all"
        else:
            got = fetch_sbdb(item.get("lookup", desig))
            if got:
                rec["name_en"], rec["elements"] = got[0], got[1]
                rec["peri_jd"] = got[1][5]
                rec["source"] = "sbdb"
            else:
                missing += 1
        # 著名な出現の日付は best 上書きを優先 (周期彗星は最新元期の tp が別出現になるため)
        rec["best_date"] = item.get("best") or (jd_to_ymd(rec["peri_jd"]) if rec["peri_jd"] else None)
        out.append(rec)

    out.sort(key=lambda r: r["best_date"] or "9999")  # 著名な出現の日付順 (古い順)
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    ok = sum(1 for r in out if r["elements"])
    print(f"  comets_notable.json: {len(out)} 件 (要素あり {ok} / 取得不可 {missing}) "
          f"({OUT.stat().st_size:,} bytes)")
    print("  ※ max_mag / note は監修前の仮置き。作者が確定すること。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
