#!/usr/bin/env python3
"""小惑星カタログ (命名済み + NEA) を JPL SBDB から取得 (PLAN5 F7)。

    python3 tools/build_asteroid_catalog.py

小天体データベース・ハブ (PLAN5) の「小惑星一覧・検索」の土台。全番号付き天体 (約90万) は
配らない (~80MB になり本体が重くなるため。撮像野の同定は外部 SkyBoT に委ねる方針)。
代わりに、人が名前・番号で探す層だけを 2 ファイルに分けて配信する:

  1. asteroids_catalog.json  … 命名済み (約2.6万)。部分一致検索・一覧・カード用
  2. asteroids_neo.json      … 地球接近小惑星=NEA 全件 (約4.2万、無名含む)。
                               命名済みだけだと NEA の 0.4% しか入らない (アポフィス級の
                               接近天体は大半が無名) ので、NEA は名前の有無に依らず全部入れる

いずれも 1件 = [番号, 英名, 主仮符号, 軌道分類, a, e, i, Ω, ω, M0, epoch(JD), H, 直径km]:
  番号   小惑星番号 (int)。無番号 (仮符号のみ) は None
  英名   "Ceres" 等。無ければ ""
  分類   MBA/NEA(ATE/APO/AMO/IEO)/MCA/TJN(Trojan)/CEN/TNO 等 (SBDB の class)
  直径   既知なら km、無ければ null

日本語名 (リュウグウ/イトカワ 等) は SBDB に無いので著名リスト側で紐付ける。
取得失敗・件数異常時は書き換えないので前回データが残る。
出典: JPL Small-Body Database (ssd-api.jpl.nasa.gov)。
"""

from __future__ import annotations

import json
import pathlib
import sys
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent
OUT = ROOT.parent / "src" / "asteroids_catalog.json"       # 命名済み
OUT_NEO = ROOT.parent / "src" / "asteroids_neo.json"        # NEA 全件
SBDB_URL = "https://ssd-api.jpl.nasa.gov/sbdb_query.api"

# 番号付き小惑星の spkid = 20000000 + 番号 (Ceres=20000001)。無番号はこの範囲外。
SPKID_BASE = 20000000
FIELDS = "spkid,name,pdes,class,a,e,i,om,w,ma,epoch,H,diameter"


def fetch_rows(cdata: dict) -> list:
    params = urllib.parse.urlencode({
        "fields": FIELDS, "sb-kind": "a", "sb-cdata": json.dumps(cdata),
    })
    url = f"{SBDB_URL}?{params}"
    req = urllib.request.Request(url, headers={"User-Agent": "voyager6-build"})
    with urllib.request.urlopen(req, timeout=180) as res:
        return json.load(res).get("data", [])


def to_rec(row: list):
    """SBDB 1行 → カタログ1件。変換不能なら None。"""
    spkid, name, pdes, cls, a, e, i, om, w, ma, epoch, H, diam = row
    try:
        num = None
        if spkid not in (None, ""):
            n = int(spkid) - SPKID_BASE
            num = n if 0 < n < 1_000_000 else None  # 範囲外(無番号)は None
        return [
            num, (name or "").strip(), (pdes or "").strip(), (cls or "").strip(),
            round(float(a), 5), round(float(e), 6), round(float(i), 4),
            round(float(om), 4), round(float(w), 4), round(float(ma), 5),
            round(float(epoch), 1), round(float(H), 2) if H not in (None, "") else None,
            round(float(diam), 3) if diam not in (None, "") else None,
        ]
    except (TypeError, ValueError):
        return None


def sort_key(r: list):
    # 番号付きを番号昇順で先に、無番号は仮符号順で後ろに
    return (r[0] is None, r[0] if r[0] is not None else 0, r[2])


def write(path: pathlib.Path, rows: list, label: str, floor: int) -> bool:
    out = [rec for rec in (to_rec(r) for r in rows) if rec is not None]
    if len(out) < floor:
        print(f"エラー: {label} が {len(out)} 件しか取れず異常。中止 (前回データ維持)。",
              file=sys.stderr)
        return False
    out.sort(key=sort_key)
    path.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    named = sum(1 for r in out if r[1])
    print(f"  {path.name}: {len(out):,} 件 (うち命名済み {named:,}) ({path.stat().st_size:,} bytes)")
    return True


def main() -> int:
    ok = True
    print("  download: 命名済み小惑星 (name|DF)")
    ok &= write(OUT, fetch_rows({"AND": ["name|DF"]}), "命名済み小惑星", floor=10000)

    print("  download: 地球接近小惑星 (neo=Y)")
    ok &= write(OUT_NEO, fetch_rows({"AND": ["neo|EQ|Y"]}), "NEA", floor=10000)

    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
