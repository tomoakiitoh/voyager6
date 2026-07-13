#!/usr/bin/env python3
"""Web星座早見 (planisphere) のデータ生成スクリプト。

外部データをダウンロードし、全ページが読む星表スクリプト
(src/data.js) を生成する。

  python3 tools/build_data.py [--maglimit 5.0] [--mw-eps 0.6]

出力される定数:
  STARS       [ra_deg, dec_deg, mag, bv]           等級 <= MAGLIMIT
  STAR_NAMES  [star_index, "日本語名"]              主要恒星
  CONST_LINES [["Abbr", [[ra,dec], ...], ...], ...] 星座線 (ポリライン)
  CONST_NAMES [["Abbr", "日本語名", ra, dec]]        星座名 + ラベル位置
  MILKYWAY    [[[[ra,dec], ...], ...], ...]         濃度レベル別ポリゴン
  MESSIER     [番号, ra, dec, 等級, 分類, 種別, 日本語名]  メシエ天体110個

データ出典 (ライセンスは data.js 冒頭のコメントにも出力する):
  - HYG Database v3.8 (astronexus/HYG-Database, CC BY-SA 2.5)
  - d3-celestial (ofrohn/d3-celestial, BSD-3-Clause) の
    constellations.lines.json / constellations.json / mw.json / messier.json
"""

from __future__ import annotations

import argparse
import csv
import gzip
import json
import math
import pathlib
import sys
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent
CACHE = ROOT / "cache"
OUTDIR = ROOT.parent / "src"

SOURCES = {
    "hyg_v38.csv.gz": "https://raw.githubusercontent.com/astronexus/HYG-Database/main/hyg/v3/hyg_v38.csv.gz",
    "constellations.lines.json": "https://raw.githubusercontent.com/ofrohn/d3-celestial/master/data/constellations.lines.json",
    "constellations.json": "https://raw.githubusercontent.com/ofrohn/d3-celestial/master/data/constellations.json",
    "mw.json": "https://raw.githubusercontent.com/ofrohn/d3-celestial/master/data/mw.json",
    "messier.json": "https://raw.githubusercontent.com/ofrohn/d3-celestial/master/data/messier.json",
}

# d3-celestial の天体種別 → 描き分けのための分類
MESSIER_KIND = {
    "gc": "cluster",   # 球状星団
    "oc": "cluster",   # 散開星団
    "pn": "nebula",    # 惑星状星雲
    "snr": "nebula",   # 超新星残骸
    "rn": "nebula",    # 反射星雲
    "sfr": "nebula",   # 散光星雲 (星形成領域)
    "e": "galaxy",     # 楕円銀河
    "s": "galaxy",     # 渦巻銀河
    "i": "galaxy",     # 不規則銀河
    "pos": "other",    # M40 (二重星) / M73 (星の集まり) など
}
KIND_JA = {
    "gc": "球状星団", "oc": "散開星団", "pn": "惑星状星雲", "snr": "超新星残骸",
    "rn": "反射星雲", "sfr": "散光星雲", "e": "楕円銀河", "s": "渦巻銀河",
    "i": "不規則銀河", "pos": "そのほか",
}

# よく知られたメシエ天体の日本語名 (すべてに付ける必要はない)
MESSIER_JA = {
    "M1": "かに星雲", "M8": "干潟星雲", "M11": "野鴨星団", "M13": "ヘルクレス座球状星団",
    "M16": "わし星雲", "M17": "オメガ星雲", "M20": "三裂星雲", "M27": "亜鈴状星雲",
    "M31": "アンドロメダ銀河", "M33": "さんかく座銀河", "M42": "オリオン大星雲",
    "M44": "プレセペ星団", "M45": "プレアデス星団 (すばる)", "M51": "子持ち銀河",
    "M57": "環状星雲", "M63": "ひまわり銀河", "M64": "黒眼銀河", "M76": "小亜鈴状星雲",
    "M81": "ボーデの銀河", "M82": "葉巻銀河", "M87": "おとめ座A (巨大楕円銀河)",
    "M97": "ふくろう星雲", "M101": "回転花火銀河", "M104": "ソンブレロ銀河",
    "M7": "プトレマイオス星団", "M35": "ふたご座の散開星団", "M6": "蝶星団",
}

LICENSE_HEADER = """/* ------------------------------------------------------------------
 * 星表データ (tools/build_data.py により自動生成 / 手で編集しないこと)
 *
 * 恒星       : HYG Database v3.8 - https://github.com/astronexus/HYG-Database
 *              (c) David Nash / astronexus, CC BY-SA 2.5
 * 星座線・星座名・天の川・メシエ天体 : d3-celestial - https://github.com/ofrohn/d3-celestial
 *              (c) Olaf Frohn, BSD-3-Clause
 *              (星座線は IAU/Stellarium "modern" 由来)
 * 座標は J2000.0 元期の赤経・赤緯 [度]。
 * ------------------------------------------------------------------ */"""

# HYG の proper 名 -> 日本語名。1.5等より明るい星 + 主要星。
STAR_NAMES_JA = {
    "Sirius": "シリウス",
    "Canopus": "カノープス",
    "Arcturus": "アークトゥルス",
    "Rigil Kentaurus": "リギル・ケンタウルス",
    "Vega": "ベガ",
    "Capella": "カペラ",
    "Rigel": "リゲル",
    "Procyon": "プロキオン",
    "Achernar": "アケルナル",
    "Betelgeuse": "ベテルギウス",
    "Hadar": "ハダル",
    "Altair": "アルタイル",
    "Acrux": "アクルックス",
    "Aldebaran": "アルデバラン",
    "Spica": "スピカ",
    "Antares": "アンタレス",
    "Pollux": "ポルックス",
    "Fomalhaut": "フォーマルハウト",
    "Mimosa": "ミモザ",
    "Deneb": "デネブ",
    "Toliman": "トリマン",
    "Regulus": "レグルス",
    "Adhara": "アダーラ",
    "Castor": "カストル",
    "Gacrux": "ガクルックス",
    "Shaula": "シャウラ",
    "Bellatrix": "ベラトリックス",
    "Elnath": "エルナト",
    "Miaplacidus": "ミアプラキドゥス",
    "Alnilam": "アルニラム",
    "Alnair": "アルナイル",
    "Alnitak": "アルニタク",
    "Alioth": "アリオト",
    "Mirfak": "ミルファク",
    "Kaus Australis": "カウス・アウストラリス",
    "Dubhe": "ドゥーベ",
    "Wezen": "ウェズン",
    "Alkaid": "アルカイド",
    "Avior": "アヴィオール",
    "Sargas": "サルガス",
    "Menkalinan": "メンカリナン",
    "Atria": "アトリア",
    "Alhena": "アルヘナ",
    "Alsephina": "アルセフィナ",
    "Peacock": "ピーコック",
    "Polaris": "ポラリス (北極星)",
    "Mirzam": "ミルザム",
    "Alphard": "アルファルド",
    "Hamal": "ハマル",
    "Algieba": "アルギエバ",
    "Diphda": "ディフダ",
    "Nunki": "ヌンキ",
    "Menkent": "メンケント",
    "Alpheratz": "アルフェラッツ",
    "Mirach": "ミラク",
    "Saiph": "サイフ",
    "Kochab": "コカブ",
    "Rasalhague": "ラス・アルハグエ",
    "Algol": "アルゴル",
    "Almach": "アルマク",
    "Denebola": "デネボラ",
    "Naos": "ナオス",
    "Alphecca": "アルフェッカ",
    "Suhail": "スハイル",
    "Mizar": "ミザール",
    "Sadr": "サドル",
    "Schedar": "シェダル",
    "Eltanin": "エルタニン",
    "Mintaka": "ミンタカ",
    "Caph": "カフ",
    "Dschubba": "ジュバ",
    "Merak": "メラク",
    "Izar": "イザール",
    "Enif": "エニフ",
    "Ankaa": "アンカア",
    "Phecda": "フェクダ",
    "Sabik": "サビク",
    "Scheat": "シェアト",
    "Alderamin": "アルデラミン",
    "Markab": "マルカブ",
    "Menkar": "メンカル",
    "Zosma": "ゾスマ",
    "Acrab": "アクラブ",
    "Arneb": "アルネブ",
    "Gienah": "ギエナー",
    "Ascella": "アスケラ",
    "Albireo": "アルビレオ",
    "Megrez": "メグレズ",
    "Alcor": "アルコル",
    "Rasalgethi": "ラス・アルゲティ",
    "Thuban": "トゥバン",
    "Sheratan": "シェラタン",
    "Aludra": "アルドラ",
    "Alcyone": "アルキオネ",
    "Zubeneschamali": "ズベン・エス・カマリ",
    "Unukalhai": "ウヌクアルハイ",
    "Alnasl": "アルナスル",
    "Nihal": "ニハル",
    "Mebsuta": "メブスタ",
    "Tejat": "テジャト",
    "Wasat": "ワサト",
    "Alterf": "アルテルフ",
    "Cor Caroli": "コル・カロリ",
    "Vindemiatrix": "ヴィンデミアトリクス",
    "Zubenelgenubi": "ズベン・エル・ゲヌビ",
    "Yed Prior": "イェド・プリオル",
    "Kornephoros": "コルネフォロス",
    "Ruchbah": "ルクバー",
    "Segin": "セギン",
    "Achird": "アキルド",
    "Alfirk": "アルフィルク",
    "Errai": "エライ",
    "Rastaban": "ラスタバン",
    "Pherkad": "フェルカド",
    "Sadalsuud": "サダルスード",
    "Sadalmelik": "サダルメリク",
    "Algenib": "アルゲニブ",
    "Acamar": "アカマル",
    "Zaurak": "ザウラク",
    "Cursa": "クルサ",
    "Meissa": "メイサ",
    "Propus": "プロプス",
    "Adhafera": "アダフェラ",
    "Chertan": "チェルタン",
    "Alula Borealis": "アルラ・ボレアリス",
    "Talitha": "タリタ",
    "Muscida": "ムシダ",
    "Nekkar": "ネッカル",
    "Seginus": "セギヌス",
    "Muphrid": "ムフリド",
    "Nusakan": "ヌサカン",
    "Sarin": "サリン",
    "Maasym": "マアシム",
    "Sheliak": "シェリアク",
    "Sulafat": "スラファト",
    "Albaldah": "アルバルダー",
    "Kaus Media": "カウス・メディア",
    "Kaus Borealis": "カウス・ボレアリス",
    "Deneb Algedi": "デネブ・アルゲディ",
    "Dabih": "ダビー",
    "Algedi": "アルゲディ",
    "Sadachbia": "サダクビア",
    "Skat": "スカト",
    "Matar": "マタル",
    "Homam": "ホマム",
    "Mesarthim": "メサルティム",
    "Botein": "ボテイン",
    "Atik": "アティク",
    "Menkib": "メンキブ",
    "Electra": "エレクトラ",
    "Maia": "マイア",
    "Merope": "メローペ",
    "Atlas": "アトラス",
    "Ain": "アイン",
    "Hassaleh": "ハッサレー",
    "Almaaz": "アルマーズ",
    "Furud": "フルド",
    "Muliphein": "ムリフェイン",
    "Gomeisa": "ゴメイサ",
    "Alkes": "アルケス",
    "Algorab": "アルゴラブ",
    "Kraz": "クラーズ",
    "Porrima": "ポリマ",
    "Heze": "ヘゼ",
    "Zavijava": "ザヴィヤヴァ",
    "Syrma": "シルマ",
    "Brachium": "ブラキウム",
    "Graffias": "グラフィアス",
    "Lesath": "レサト",
    "Cebalrai": "ケバルライ",
    "Yed Posterior": "イェド・ポステリオル",
    "Marfik": "マルフィク",
    "Alya": "アルヤ",
    "Tarazed": "タラゼド",
    "Alshain": "アルシャイン",
    "Altais": "アルタイス",
    "Edasich": "エダシク",
    "Grumium": "グルミウム",
    "Aljanah": "アルジャナー",
    "Fawaris": "ファワリス",
    "Azelfafage": "アゼルファファゲ",
    "Cih": "ツィー",
    "Larawag": "ララワグ",
    "Tiaki": "チアキ",
    "Aspidiske": "アスピディスケ",
    "Markeb": "マルケブ",
    "Alpherg": "アルフェルグ",
    "Alrescha": "アルレシャ",
    "Sadalbari": "サダルバリ",
    "Rana": "ラナ",
    "Beid": "ベイド",
    "Keid": "ケイド",
    "Angetenar": "アンゲテナル",
    "Azha": "アザー",
    "Sceptrum": "スケプトルム",
    "Theemin": "テーミン",
    "Kurhah": "クルハー",
}


def fetch(name: str) -> pathlib.Path:
    """キャッシュ付きダウンロード。"""
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / name
    if path.exists() and path.stat().st_size > 0:
        print(f"  cached: {name} ({path.stat().st_size:,} bytes)")
        return path
    url = SOURCES[name]
    print(f"  download: {url}")
    with urllib.request.urlopen(url, timeout=300) as res, path.open("wb") as f:
        f.write(res.read())
    print(f"    -> {name} ({path.stat().st_size:,} bytes)")
    return path


def norm_ra(ra: float) -> float:
    """赤経を 0<=ra<360 に正規化する。"""
    return ra % 360.0


def build_stars(maglimit: float):
    """HYG から等級 <= maglimit の恒星と、その中の主要星の日本語名を作る。"""
    path = fetch("hyg_v38.csv.gz")
    stars = []  # (mag, ra, dec, bv, proper)
    with gzip.open(path, "rt", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            if row["id"] == "0":  # 太陽は別途計算するので除外
                continue
            try:
                mag = float(row["mag"])
            except ValueError:
                continue
            if mag > maglimit:
                continue
            ra = float(row["ra"]) * 15.0  # HYG の ra は「時」単位
            dec = float(row["dec"])
            try:
                bv = float(row["ci"])
            except ValueError:
                bv = 0.0
            stars.append((mag, ra, dec, bv, row["proper"].strip()))

    stars.sort(key=lambda s: s[0])  # 明るい順。描画順と「明るい星を優先」に都合がよい
    out_stars = [
        [round(ra, 3), round(dec, 3), round(mag, 2), round(bv, 2)]
        for mag, ra, dec, bv, _ in stars
    ]

    names = []
    unmatched = set(STAR_NAMES_JA)
    for i, (_, _, _, _, proper) in enumerate(stars):
        ja = STAR_NAMES_JA.get(proper)
        if ja:
            names.append([i, ja])
            unmatched.discard(proper)
    if unmatched:
        print(f"  ! 日本語名テーブルに未使用のエントリ: {sorted(unmatched)}")
    return out_stars, names


def build_const_lines():
    """星座線ポリライン。座標は 0-360 度に正規化する。"""
    path = fetch("constellations.lines.json")
    gj = json.loads(path.read_text(encoding="utf-8"))
    out = []
    nseg = 0
    for feat in gj["features"]:
        lines = []
        for line in feat["geometry"]["coordinates"]:
            pts = [[round(norm_ra(p[0]), 2), round(p[1], 2)] for p in line]
            if len(pts) >= 2:
                lines.append(pts)
                nseg += len(pts) - 1
        if lines:
            out.append([feat["id"], lines])
    print(f"  星座線: {len(out)} 星座 / {nseg} 線分")
    return out


def build_const_names():
    """星座の日本語名とラベル位置。"""
    path = fetch("constellations.json")
    gj = json.loads(path.read_text(encoding="utf-8"))
    out = []
    for feat in gj["features"]:
        p = feat["properties"]
        ja = p.get("ja") or p.get("name")
        lon, lat = feat["geometry"]["coordinates"]
        out.append([feat["id"], ja, round(norm_ra(lon), 2), round(lat, 2)])
    return out


def build_messier():
    """メシエ天体 110 個。"""
    path = fetch("messier.json")
    gj = json.loads(path.read_text(encoding="utf-8"))
    out = []
    for feat in gj["features"]:
        p = feat["properties"]
        lon, lat = feat["geometry"]["coordinates"]
        mag = p.get("mag")
        if mag is None or mag == "":
            mag = 99  # 等級不明のものは暗いものとして扱う
        out.append([
            p["name"],                                  # M31 など
            round(norm_ra(lon), 3), round(lat, 3),
            round(float(mag), 1),
            MESSIER_KIND.get(p.get("type"), "other"),   # 描き分け用の分類
            KIND_JA.get(p.get("type"), ""),             # 種別の日本語
            MESSIER_JA.get(p["name"], ""),              # 日本語の通称 (無ければ空)
        ])
    out.sort(key=lambda m: int(m[0][1:]))
    kinds = {}
    for m in out:
        kinds[m[4]] = kinds.get(m[4], 0) + 1
    print(f"  メシエ天体: {len(out)} 個 {kinds}")
    return out


def rdp(points, eps):
    """Ramer-Douglas-Peucker による折れ線の間引き (平面近似)。"""
    if len(points) < 3:
        return list(points)
    stack = [(0, len(points) - 1)]
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    while stack:
        i, j = stack.pop()
        if j - i < 2:
            continue
        ax, ay = points[i]
        bx, by = points[j]
        dx, dy = bx - ax, by - ay
        norm = math.hypot(dx, dy)
        dmax, imax = -1.0, i
        for k in range(i + 1, j):
            px, py = points[k]
            if norm == 0:
                d = math.hypot(px - ax, py - ay)
            else:
                d = abs(dx * (ay - py) - (ax - px) * dy) / norm
            if d > dmax:
                dmax, imax = d, k
        if dmax > eps:
            keep[imax] = True
            stack.append((i, imax))
            stack.append((imax, j))
    return [p for p, k in zip(points, keep) if k]


def unwrap_lon(ring):
    """RA が ±180 をまたぐ環を連続値に開く (RDP を平面で行うため)。"""
    out = [list(ring[0])]
    for p in ring[1:]:
        prev = out[-1][0]
        lon = p[0]
        while lon - prev > 180:
            lon -= 360
        while lon - prev < -180:
            lon += 360
        out.append([lon, p[1]])
    return out


def build_milkyway(eps: float):
    """天の川の等高線ポリゴン (濃度レベル 5 段階) を間引いて出力。"""
    path = fetch("mw.json")
    gj = json.loads(path.read_text(encoding="utf-8"))
    levels = []
    before = after = 0
    for feat in gj["features"]:  # ol1..ol5 (外側=薄い -> 内側=濃い)
        rings_out = []
        for poly in feat["geometry"]["coordinates"]:
            for ring in poly:
                before += len(ring)
                simplified = rdp(unwrap_lon(ring), eps)
                if len(simplified) < 4:
                    continue
                after += len(simplified)
                rings_out.append(
                    [[round(norm_ra(p[0]), 1), round(p[1], 1)] for p in simplified]
                )
        levels.append(rings_out)
    print(f"  天の川: {len(levels)} レベル / 頂点 {before} -> {after} (eps={eps}°)")
    return levels


def js_array(rows, per_line=1):
    """JS の配列リテラルを、行数を抑えつつ人が見られる程度に整形する。"""
    items = [json.dumps(r, ensure_ascii=False, separators=(",", ":")) for r in rows]
    lines = []
    for i in range(0, len(items), per_line):
        lines.append(" " + ",".join(items[i : i + per_line]) + ",")
    return "[\n" + "\n".join(lines) + "\n]"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--maglimit", type=float, default=5.0, help="恒星の等級上限")
    ap.add_argument("--mw-eps", type=float, default=0.3, help="天の川の間引き許容誤差[度]")
    args = ap.parse_args()

    print("データ取得...")
    stars, star_names = build_stars(args.maglimit)
    lines = build_const_lines()
    cnames = build_const_names()
    mw = build_milkyway(args.mw_eps)
    messier = build_messier()
    print(f"  恒星: {len(stars)} 個 (mag <= {args.maglimit}) / 日本語星名 {len(star_names)} 個")
    print(f"  星座名: {len(cnames)} 個")

    OUTDIR.mkdir(parents=True, exist_ok=True)
    out = OUTDIR / "data.js"
    with out.open("w", encoding="utf-8") as f:
        f.write(LICENSE_HEADER + "\n\n")
        f.write("// [赤経°, 赤緯°, 実視等級, B-V] 明るい順\n")
        f.write("const STARS = " + js_array(stars, per_line=6) + ";\n\n")
        f.write("// [STARS の添字, 日本語星名]\n")
        f.write("const STAR_NAMES = " + js_array(star_names, per_line=4) + ";\n\n")
        f.write("// [星座略号, [ポリライン[[赤経°, 赤緯°], ...], ...]]\n")
        f.write("const CONST_LINES = " + js_array(lines, per_line=1) + ";\n\n")
        f.write("// [星座略号, 日本語名, ラベル赤経°, ラベル赤緯°]\n")
        f.write("const CONST_NAMES = " + js_array(cnames, per_line=3) + ";\n\n")
        f.write("// 濃度レベル(薄->濃)ごとの多角形リング [[[赤経°, 赤緯°], ...], ...]\n")
        f.write("const MILKYWAY = " + js_array(mw, per_line=1) + ";\n\n")
        f.write("// [番号, 赤経°, 赤緯°, 等級, 分類(galaxy/cluster/nebula/other), 種別, 日本語名]\n")
        f.write("const MESSIER = " + js_array(messier, per_line=2) + ";\n")

    size = out.stat().st_size
    print(f"\n出力: {out} ({size:,} bytes / {size/1024:.1f} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
