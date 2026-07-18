#!/usr/bin/env python3
"""命名済み小惑星カタログを JPL SBDB から取得して src/asteroids_catalog.json を生成 (PLAN5 F7)。

    python3 tools/build_asteroid_catalog.py

小天体データベース・ハブ (PLAN5) の「小惑星一覧・検索」の土台。全番号付き天体 (百万規模) は
配らず、**命名済み (約2.6万件)** だけを配信する。部分一致検索・一覧表・カードで使う。
番号や仮符号での完全一致は将来 SBDB オンデマンド参照でも足せる (ここでは持たない)。

日本語名 (リュウグウ/イトカワ 等) は SBDB に無いので、著名小惑星の監修リスト (F7 別ファイル)
側で紐付ける。ここは英名・番号・仮符号までを持つ。

出力 (JSON 配列、1件 = [番号, 英名, 主仮符号, 軌道分類, a, e, i, Ω, ω, M0, epoch(JD), H, 直径km]):
  番号   小惑星番号 (int)。name が付く=番号付きなので基本 int
  英名   "Ceres" 等。無ければ ""
  分類   MBA / NEA / MCA / IMB / TJN(Trojan) / CEN(Centaur) / TNO 等 (SBDB の class)
  直径   既知なら km、無ければ null

取得失敗・件数異常時は書き換えないので前回データが残る (サイトを壊さない)。
出典: JPL Small-Body Database (ssd-api.jpl.nasa.gov)。
"""

from __future__ import annotations

import json
import pathlib
import sys
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent
OUT = ROOT.parent / "src" / "asteroids_catalog.json"
SBDB_URL = "https://ssd-api.jpl.nasa.gov/sbdb_query.api"


def main() -> int:
    params = urllib.parse.urlencode({
        # spkid から番号を復元 (番号付き小惑星の spkid = 20000000 + 番号。Ceres=20000001)
        "fields": "spkid,name,pdes,class,a,e,i,om,w,ma,epoch,H,diameter",
        "sb-kind": "a",
        "sb-cdata": json.dumps({"AND": ["name|DF"]}),  # name が定義済み = 命名済み
    })
    url = f"{SBDB_URL}?{params}"
    print(f"  download: {SBDB_URL} (命名済み小惑星)")
    req = urllib.request.Request(url, headers={"User-Agent": "voyager6-build"})
    with urllib.request.urlopen(req, timeout=180) as res:
        d = json.load(res)

    rows = d.get("data", [])
    out = []
    for row in rows:
        spkid, name, pdes, cls, a, e, i, om, w, ma, epoch, H, diam = row
        try:
            num = int(spkid) - 20000000 if spkid not in (None, "") else None
            rec = [
                num,
                (name or "").strip(),
                (pdes or "").strip(),
                (cls or "").strip(),
                round(float(a), 5), round(float(e), 6), round(float(i), 4),
                round(float(om), 4), round(float(w), 4), round(float(ma), 5),
                round(float(epoch), 1), round(float(H), 2) if H not in (None, "") else None,
                round(float(diam), 3) if diam not in (None, "") else None,
            ]
        except (TypeError, ValueError):
            continue
        out.append(rec)

    if len(out) < 10000:  # 命名済みは 2.6万規模。1万未満は取得異常とみなし前回を守る
        print(f"エラー: 命名済み小惑星が {len(out)} 件しか取れず異常。中止。", file=sys.stderr)
        return 1

    out.sort(key=lambda r: (r[0] is None, r[0]))  # 番号昇順 (Ceres=1 が先頭)
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"  asteroids_catalog.json: {len(out):,} 件 ({OUT.stat().st_size:,} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
