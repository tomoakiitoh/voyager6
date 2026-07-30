#!/usr/bin/env python3
"""GCVS から変光星カタログ (拡張版) を生成する。

    python3 tools/build_variables_all.py

既存の src/variables.json (著名23天体・手書きコメントつき) は**凍結**し、こちらを別ファイルで
足す。既存ファイルの形式・内容を変えないのは、URL とデータ形式が外部との約束だから。

出典: GCVS 5.1 (Samus+, モスクワ大 Sternberg 天文研究所)。学術・自由利用の伝統 (要出典表示)。
海岸線などと同じく更新頻度が低いので cron ではなく手動再実行でよい。

出力 src/variables_all.json = JSON 配列、1件 =
  [name, ra(deg), dec(deg), type, magMax, magMin|null, period(日)|null, epoch(JD-2400000)|null]

  ※ epoch の意味は型で違う: 脈動星 (M/SR/CEP/RR…) は**極大**、食変光星 (EA/EB/EW) は**極小**。
    GCVS の定義そのままなので、使う側でこの違いを踏まえること。

収録基準 (全収録はしない。読める星図・軽いカタログが正義):
  - **測光系が V のものだけ**。GCVS には K/J (赤外) や p (写真) の等級が混在していて、
    たとえば LP And は「最大1.8等」だがこれは K 等級で、眼視では15等より暗い。
    測光系を見ずに等級で絞ると、こういう星が「明るい変光星」として紛れ込む。
  - 最大等級 (V) ≤ 10.0
  - 型は眼視観測の対象になるもの (下の TYPES)。既存23天体で使っている型は全部含める。
"""

from __future__ import annotations

import json
import math
import pathlib
import re
import sys
import time
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent
CACHE = ROOT / "cache"
OUT = ROOT.parent / "src" / "variables_all.json"

SOURCE_NAME = "gcvs5.txt"
SOURCE_URL = "http://www.sai.msu.su/gcvs/gcvs/gcvs5/gcvs5.txt"
USER_AGENT = "Voyager6/1.0 (+https://voyager6.net/; astronomy star chart)"

MAG_LIMIT = 10.0

# 主分類 (スラッシュ・プラス以降のサブタイプは落として判定する)。
# 前半=プランの対象、後半=既存 variables.json が使っている型 (SS Cyg・R CrB・γ Cas 等を落とさない)。
TYPES = {
    "M", "SR", "SRA", "SRB", "SRC", "SRD",              # 長周期・半規則
    "EA", "EB", "EW",                                    # 食変光星
    "DCEP", "DCEPS", "CEP", "CW", "CWA", "CWB",          # セファイド
    "RR", "RRAB", "RRC",                                 # RR Lyr 型
    "N", "NA", "NB", "NC", "NR",                         # 新星・再帰新星
    "UG", "UGSS", "UGSU", "UGZ",                         # 矮新星 (SS Cyg, U Gem)
    "RCB", "GCAS", "SDOR", "RVA", "RVB", "LB", "LC",     # その他の眼視対象
}


def fetch() -> pathlib.Path:
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / SOURCE_NAME
    if path.exists() and path.stat().st_size > 0:
        print(f"  cached: {SOURCE_NAME} ({path.stat().st_size:,} bytes)")
        return path
    print(f"  download: {SOURCE_URL}")
    req = urllib.request.Request(SOURCE_URL, headers={"User-Agent": USER_AGENT})
    last = None
    for attempt in (1, 2):          # 失敗時のみ1回だけ再試行 (連打しない)
        try:
            with urllib.request.urlopen(req, timeout=300) as res, path.open("wb") as f:
                f.write(res.read())
            print(f"    -> {SOURCE_NAME} ({path.stat().st_size:,} bytes)")
            return path
        except Exception as e:  # noqa: BLE001
            last = e
            if attempt == 1:
                print(f"  警告: 取得失敗 ({e})。20秒後に1回だけ再試行。", file=sys.stderr)
                time.sleep(20)
    raise last


def num(s: str):
    """'  5.8    ' や '53820.' → float。'<16.' のような下限記号や ':' (不確か) は落とす。"""
    t = re.sub(r"[^0-9.]", "", s or "")
    if not t or t == ".":
        return None
    try:
        return float(t)
    except ValueError:
        return None


def coords(s: str):
    """'002401.95  +383437.3' → (ra_deg, dec_deg)。J2000。"""
    m = re.match(r"^(\d{2})(\d{2})(\d{2}\.?\d*)\s*([+-])(\d{2})(\d{2})(\d{2}\.?\d*)", s.strip())
    if not m:
        return None
    hh, mm, ss, sign, dd, dm, ds = m.groups()
    ra = (int(hh) + int(mm) / 60 + float(ss) / 3600) * 15.0
    dec = int(dd) + int(dm) / 60 + float(ds) / 3600
    if sign == "-":
        dec = -dec
    return ra, dec


def main_type(t: str) -> str:
    return t.split("/")[0].split("+")[0].strip().rstrip(":")


def main() -> int:
    path = fetch()
    out = []
    seen = set()
    stats = {"total": 0, "nocoord": 0, "notV": 0, "toofaint": 0, "type": 0}

    with path.open(encoding="utf-8", errors="replace") as f:
        for line in f:
            p = line.split("|")
            if len(p) < 13:
                continue
            stats["total"] += 1

            mag_max = num(p[4])
            if mag_max is None:
                continue
            if p[7].strip() != "V":            # 測光系。V 以外 (K/J/p/Hp…) は等級の意味が違う
                stats["notV"] += 1
                continue
            if mag_max > MAG_LIMIT:
                stats["toofaint"] += 1
                continue
            typ = p[3].strip()
            if main_type(typ) not in TYPES:
                stats["type"] += 1
                continue
            c = coords(p[2])
            if not c:
                stats["nocoord"] += 1
                continue

            name = " ".join(p[1].split()).replace(" *", "").strip()
            if not name or name in seen:
                continue
            seen.add(name)

            period = num(p[10])
            if period is not None and period <= 0:
                period = None
            out.append([name, round(c[0], 5), round(c[1], 5), typ,
                        round(mag_max, 2),
                        (round(num(p[5]), 2) if num(p[5]) is not None else None),
                        (round(period, 4) if period is not None else None),
                        (round(num(p[8]), 3) if num(p[8]) is not None else None)])

    out.sort(key=lambda r: r[4])       # 明るい順
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    withper = sum(1 for r in out if r[6] is not None)
    withep = sum(1 for r in out if r[7] is not None and r[6] is not None)
    print(f"src/variables_all.json: {len(out):,} 件 ({OUT.stat().st_size:,} bytes)")
    print(f"  周期あり {withper:,} / 元期と周期の両方あり {withep:,}")
    print(f"  除外: V以外の測光系 {stats['notV']:,} / {MAG_LIMIT}等より暗い {stats['toofaint']:,} / "
          f"対象外の型 {stats['type']:,} / 座標なし {stats['nocoord']:,}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
