#!/usr/bin/env python3
"""日食・月食・流星群のテーブルを src/events.js に生成する。

    python3 tools/build_events.py

食は計算せず、確定済みのカタログを取り込む (SITE_PLAN.md 6章)。
日食の局地的な状況 (食分・接触時刻) は、うちの位置精度 (太陽0.3°・月0.5°) では
太陽の視直径 0.53° に対して意味のある値にならないので出さない。
月食は地心現象なので「その時刻に月が地平線上にあるか」で見える/見えないが決まり、
これはサイト側で計算する。

出典: NASA Eclipse Web Site (Fred Espenak) — パブリックドメイン
      https://eclipse.gsfc.nasa.gov/
流星群の極大は太陽黄経 (λ☉, J2000.0) で与える。年ごとの日時はサイト側で計算する。
出典: IMO (International Meteor Organization) の流星群カレンダー
"""

from __future__ import annotations

import pathlib
import re
import sys
import urllib.request
import html as htmllib

ROOT = pathlib.Path(__file__).resolve().parent.parent
CACHE = ROOT / "tools" / "cache"
OUT = ROOT / "src" / "events.js"

DECADES = ["2021", "2031"]  # 2021-2040 をカバーする

MONTHS = {m: i + 1 for i, m in enumerate(
    "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split())}

# NASA の地域表記 → 日本語。
REGION_JA = {
    "N. America": "北アメリカ", "S. America": "南アメリカ", "Americas": "南北アメリカ",
    "Mid East": "中東", "Indian Ocean": "インド洋", "Atlantic": "大西洋",
    "Pacific": "太平洋", "Arctic": "北極", "Antarctica": "南極",
    "Australia": "オーストラリア", "Europe": "ヨーロッパ", "Africa": "アフリカ",
    "Asia": "アジア", "Greenland": "グリーンランド", "Canada": "カナダ",
    "Russia": "ロシア", "Japan": "日本", "New Zealand": "ニュージーランド",
    "Alaska": "アラスカ", "Hawaii": "ハワイ", "Iceland": "アイスランド",
    "Indonesia": "インドネシア", "Philippines": "フィリピン", "India": "インド",
    "China": "中国", "Brazil": "ブラジル", "Mexico": "メキシコ", "Spain": "スペイン",
    "Middle East": "中東", "Caribbean": "カリブ海", "Scandinavia": "北欧",
    "N.Z.": "ニュージーランド", "Argentina": "アルゼンチン", "Chile": "チリ",
    "SE Asia": "東南アジア", "E. Indies": "東インド諸島", "America": "アメリカ",
    "Indian Oc.": "インド洋", "Atlantic Oc.": "大西洋", "Pacific Oc.": "太平洋",
}
# 方角は接頭辞ではなく接尾辞にする ("n N. America" → 北アメリカ北部)
DIRECTION_JA = {
    "n": "北部", "s": "南部", "e": "東部", "w": "西部", "c": "中部",
    "ne": "北東部", "nw": "北西部", "se": "南東部", "sw": "南西部",
}
# "C. & S. America" のように、地名を後ろに従える略記
PREFIX_JA = {"N.": "北", "S.": "南", "E.": "東", "W.": "西", "C.": "中央"}

TYPE_JA = {
    "Total": "皆既", "Annular": "金環", "Hybrid": "金環皆既",
    "Partial": "部分", "Penumbral": "半影",
}


def fetch(kind: str, decade: str) -> str:
    """NASA の 10年カタログ (SEdecade / LEdecade) を取る。"""
    CACHE.mkdir(parents=True, exist_ok=True)
    name = f"{kind}decade{decade}.html"
    path = CACHE / name
    if not path.exists() or path.stat().st_size == 0:
        url = f"https://eclipse.gsfc.nasa.gov/{kind}decade/{name}"
        print(f"  download: {url}")
        with urllib.request.urlopen(url, timeout=60) as res:
            path.write_bytes(res.read())
    else:
        print(f"  cached: {name}")
    return path.read_text(errors="replace")


def parse_rows(html: str):
    """カタログの表から行を取り出す。"""
    out = []
    for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", html, re.S | re.I):
        cells = [
            htmllib.unescape(re.sub(r"<[^>]+>", "", c)).replace("\xa0", " ").strip()
            for c in re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", tr, re.S | re.I)
        ]
        if cells and re.match(r"20\d\d [A-Z][a-z][a-z] \d\d", cells[0]):
            out.append(cells)
    return out


def to_iso(date_str: str) -> str:
    y, mon, d = date_str.split()
    return f"{y}-{MONTHS[mon]:02d}-{int(d):02d}"


def region_ja(text: str) -> str:
    """地域表記を日本語にする。訳せない語はそのまま残す。

    "n N. America, e Asia" → "北アメリカ北部, アジア東部"
    """
    text = text.split("\n")[0].strip()  # [Total: ...] の補足行は落とす
    out = []
    tokens = [t.strip() for part in text.split(",") for t in part.split("&")]
    pending = []  # "w & s Africa" のように方角だけが先に来る場合の置き場
    for token in tokens:
        if not token:
            continue
        if re.fullmatch(r"[nsewc]{1,2}|[NSEWC]\.", token):  # 地名が後から来る方角
            pending.append(token)
            continue
        m = re.match(r"^([nsewc]{1,2})\s+(.+)$", token)
        direction, region = (m.group(1), m.group(2)) if m else ("", token)
        ja = REGION_JA.get(region, region)
        for d in pending:                          # 溜めておいた方角も同じ地名に付ける
            if d in PREFIX_JA:                     # "C. & S. America" → 中央アメリカ
                base = REGION_JA.get(region.split(". ", 1)[-1], region)
                out.append(PREFIX_JA[d] + REGION_JA.get(base, base))
            else:
                out.append(ja + DIRECTION_JA.get(d, d))
        pending = []
        if direction:
            ja += DIRECTION_JA.get(direction, f"({direction})")
        out.append(ja)
    return ", ".join(out)


# 主要流星群。λ☉ は J2000.0 の太陽黄経 [度] (IMO の流星群カレンダーによる)。
# 極大の日時はこの λ☉ から年ごとに計算する (毎年ほぼ同じ黄経で極大を迎えるため、
# 日付を決め打ちするより正確)。radiant は輻射点 [赤経°, 赤緯°]、zhr は好条件での目安。
METEORS = [
    ("しぶんぎ座流星群", 283.15, 110, 230.0, 49.0, "1月上旬。極大が数時間と鋭い"),
    ("こと座流星群", 32.32, 18, 271.0, 34.0, "4月中旬〜下旬"),
    ("みずがめ座η流星群", 45.5, 50, 338.0, -1.0, "5月上旬。日本では夜明け前だけ"),
    ("みずがめ座δ南流星群", 125.0, 25, 340.0, -16.0, "7月下旬。だらだら長く続く"),
    ("やぎ座α流星群", 127.0, 5, 307.0, -10.0, "7月下旬。数は少ないが火球が多い"),
    ("ペルセウス座流星群", 140.0, 100, 48.0, 58.0, "8月中旬。三大流星群のひとつ"),
    ("りゅう座流星群", 195.4, 10, 262.0, 54.0, "10月上旬。宵のうちが勝負。突発することがある"),
    ("オリオン座流星群", 208.0, 20, 95.0, 16.0, "10月下旬"),
    ("おうし座南流星群", 223.0, 5, 52.0, 15.0, "11月上旬。ゆっくりした流星"),
    ("おうし座北流星群", 230.0, 5, 58.0, 22.0, "11月中旬"),
    ("しし座流星群", 235.27, 15, 152.0, 22.0, "11月中旬"),
    ("ふたご座流星群", 262.2, 150, 112.0, 33.0, "12月中旬。三大流星群で最も安定"),
    ("こぐま座流星群", 270.7, 10, 217.0, 76.0, "12月下旬"),
]


def js(value) -> str:
    import json
    return json.dumps(value, ensure_ascii=False)


def main() -> int:
    print("食のカタログを取得...")
    solar, lunar = [], []
    for decade in DECADES:
        for row in parse_rows(fetch("SE", decade)):
            date, tdmax, kind = row[0], row[1], row[2]
            solar.append([to_iso(date), tdmax, TYPE_JA.get(kind, kind), region_ja(row[6])])
        for row in parse_rows(fetch("LE", decade)):
            date, tdmax, kind = row[0], row[1], row[2]
            # 継続時間の欄は「部分食」と「皆既」がくっついて入っている ("03h27m00h58m")。
            # 半影食では "-"。読めるように分けておく。
            raw = row[5] if len(row) > 5 else ""
            durs = re.findall(r"\d\dh\d\dm", raw)
            partial = durs[0] if durs else ""
            total = durs[1] if len(durs) > 1 else ""
            lunar.append([to_iso(date), tdmax, TYPE_JA.get(kind, kind),
                          partial, total, region_ja(row[6])])

    solar.sort()
    lunar.sort()
    print(f"  日食 {len(solar)} 件 / 月食 {len(lunar)} 件 ({DECADES[0]}〜)")

    with OUT.open("w", encoding="utf-8") as f:
        f.write('"use strict";\n\n')
        f.write("""/* ------------------------------------------------------------------
 * 日食・月食・流星群のテーブル (tools/build_events.py が生成 / 手で編集しないこと)
 *
 * 食: NASA Eclipse Web Site (Fred Espenak) https://eclipse.gsfc.nasa.gov/
 *     パブリックドメイン。日時は最大食の瞬間 (TD ≒ UT)。
 *     日食の局地的な状況 (食分・接触時刻) はこのサイトでは扱わない。
 * 流星群: IMO の流星群カレンダーによる λ☉ (J2000.0 の太陽黄経)。
 *     年ごとの極大日時は sky.js が λ☉ から計算する。
 * ------------------------------------------------------------------ */\n\n""")
        f.write("// [日付(UT), 最大食の時刻(UT), 種類, 見られる地域]\n")
        f.write("const ECLIPSES_SOLAR = [\n")
        for e in solar:
            f.write(f"  {js(e)},\n")
        f.write("];\n\n")
        f.write("// [日付(UT), 最大食の時刻(UT), 種類, 部分食の継続, 皆既の継続, 見られる地域]\n")
        f.write("const ECLIPSES_LUNAR = [\n")
        for e in lunar:
            f.write(f"  {js(e)},\n")
        f.write("];\n\n")
        f.write("// [名前, λ☉(J2000)°, ZHR目安, 輻射点RA°, 輻射点Dec°, メモ]\n")
        f.write("const METEOR_SHOWERS = [\n")
        for m in METEORS:
            f.write(f"  {js(list(m))},\n")
        f.write("];\n")

    size = OUT.stat().st_size
    print(f"\n出力: {OUT} ({size:,} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
