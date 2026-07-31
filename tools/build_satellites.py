#!/usr/bin/env python3
"""CelesTrak の TLE を取得して src/satellites.json を生成する (PLAN6 F1)。

    python3 tools/build_satellites.py

TLE (二行軌道要素) は鮮度が命 (LEO は数日で劣化) なので、build(push) ではなく
日次 cron で更新する。位置計算はクライアントで satellite.js (SGP4) が行う。
取得・検証に失敗したら前回の src/satellites.json のまま (サイトを壊さない)。

常用グループ:
  stations … ISS・中国宇宙ステーション等 (station keeping されている有人系)
  visual  … 肉眼で見える明るい衛星 約150機 (Heavens-Above の "brightest" 相当)
全カタログ (1万機超) は同定モード用に将来オンデマンドで別途扱う (今はスコープ外)。

出力 (JSON 配列、1件 = [名前, NORAD, TLE1行目, TLE2行目, 標準等級|null]):
  標準等級 = 1000km・位相角90°・半照時の実視等級の目安 (Heavens-Above の "std mag" 相当)。
  機械可読な配布元が現状ないため、確度の高い著名機のみ内蔵表から与え、他は null。
  クライアントは TLE 1行目の元期から鮮度 (経過日数) を計算して表示する。
"""

from __future__ import annotations

import json
import pathlib
import sys
import time
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent
OUT = ROOT.parent / "src" / "satellites.json"
# Starlink は約1万機と大きいが、CelesTrak が CI から落ちると build 時生成では消えてしまうため
# committed 済み (前回データ保持)。日次 cron が更新し、push デプロイは committed 版を配信する。
# 同定モードの全カタログ検索と地球周回3Dの「コンステレーション網」表示にオンデマンドで使う。
OUT_STARLINK = ROOT.parent / "src" / "satellites_starlink.json"
# 静止衛星 (約570機)。知名度が高い割に、明るい衛星のグループには入っていない
# (視等級10〜13等で眼視では見えないため)。地球周回3Dで「静止軌道の輪の上に並ぶ」姿を見せる用。
OUT_GEO = ROOT.parent / "src" / "satellites_geo.json"
GP = "https://celestrak.org/NORAD/elements/gp.php?GROUP={group}&FORMAT=tle"
GROUPS = ["stations", "visual"]   # stations を先に (ISS/CSS を上位に置く)

# 著名機の標準等級 (実視等級の目安。Heavens-Above 等で広く使われている値)。
# 出典が単一の機械可読ファイルにまとまっていないため、確度の高いものだけ手入力する。
STD_MAG = {
    25544: -1.8,   # ISS (ZARYA)
    48274: -1.0,   # CSS (TIANHE) 中国宇宙ステーション
    20580: 1.9,    # HST ハッブル宇宙望遠鏡
    25338: 3.0,    # NOAA 15
    28654: 3.0,    # NOAA 18
    33591: 3.0,    # NOAA 19
    27424: 3.5,    # AQUA
    25994: 3.5,    # TERRA
    39084: 3.5,    # LANDSAT 8
    36508: 3.0,    # CRYOSAT 2
    38771: 2.5,    # METOP-B
}


# CelesTrak に自分を名乗る (連絡先=サイトURL)。素性不明の弾き(403)を避ける。
USER_AGENT = "Voyager6/1.0 (+https://voyager6.net/; satellite finder)"
RETRY_WAIT = 60   # 取得失敗時、1回だけ待って再試行する秒数。CelesTrak を連打しない。


def fetch_tle(group: str) -> str:
    """CelesTrak から TLE を取得。失敗時は 60秒待って 1回だけ再試行 (連打はしない)。"""
    url = GP.format(group=group)
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    last = None
    for attempt in (1, 2):
        try:
            with urllib.request.urlopen(req, timeout=90) as res:
                return res.read().decode("utf-8", "replace")
        except Exception as e:  # noqa: BLE001
            last = e
            if attempt == 1:
                print(f"  警告: {group} 取得失敗 ({e})。{RETRY_WAIT}秒後に1回だけ再試行(連打しない)。",
                      file=sys.stderr)
                time.sleep(RETRY_WAIT)
    raise last


def parse_tle(text: str) -> list[tuple[str, int, str, str]]:
    """3行1組 (名前/1行目/2行目) をパースして [(name, norad, l1, l2), ...] を返す。"""
    lines = [ln.rstrip() for ln in text.splitlines() if ln.strip()]
    out = []
    i = 0
    while i + 2 < len(lines) + 1 and i + 2 <= len(lines):
        name, l1, l2 = lines[i], lines[i + 1], lines[i + 2] if i + 2 < len(lines) else ""
        if l1.startswith("1 ") and l2.startswith("2 ") and len(l1) >= 63 and len(l2) >= 63:
            try:
                norad = int(l1[2:7])
            except ValueError:
                i += 1
                continue
            out.append((name.strip(), norad, l1, l2))
            i += 3
        else:
            i += 1   # 崩れた並びは1行ずらして復帰
    return out


def main() -> int:
    records: dict[int, tuple[str, int, str, str]] = {}
    for group in GROUPS:
        try:
            recs = parse_tle(fetch_tle(group))
        except Exception as e:  # noqa: BLE001
            print(f"警告: {group} の取得に失敗 ({e})。", file=sys.stderr)
            continue
        for name, norad, l1, l2 in recs:
            records.setdefault(norad, (name, norad, l1, l2))  # 先に入れた stations を優先
        print(f"  {group}: {len(recs)} 機")

    if len(records) < 50:
        # まともに取れていない (再試行しても失敗)。前回データを壊さずに正常終了する
        # (satellites.json を書き換えない=前回維持、ジョブは緑、警告ログのみ)。
        print(f"警告: 取得 {len(records)} 機は少なすぎる。前回の satellites.json を維持して正常終了。",
              file=sys.stderr)
        return 0

    # stations→visual の順を保ちつつ配列化 (dict は挿入順)
    out = [[name, norad, l1, l2, STD_MAG.get(norad)]
           for (name, norad, l1, l2) in records.values()]
    OUT.write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    withmag = sum(1 for r in out if r[4] is not None)
    print(f"src/satellites.json: {len(out)} 機 (標準等級つき {withmag})")

    # Starlink (大きいので別ファイル・gitignore・失敗しても本編は壊さない)
    try:
        sl = parse_tle(fetch_tle("starlink"))
        if len(sl) > 500:
            arr = [[name, norad, l1, l2] for (name, norad, l1, l2) in sl]
            OUT_STARLINK.write_text(json.dumps(arr, ensure_ascii=False), encoding="utf-8")
            print(f"src/satellites_starlink.json: {len(arr)} 機")
        else:
            print(f"警告: starlink {len(sl)} 機は少なすぎる。生成をスキップ。", file=sys.stderr)
    except Exception as e:  # noqa: BLE001
        print(f"警告: starlink の取得に失敗 ({e})。スキップ。", file=sys.stderr)

    # 静止衛星 (失敗しても本編は壊さない)
    try:
        geo = parse_tle(fetch_tle("geo"))
        if len(geo) > 100:
            arr = [[name, norad, l1, l2] for (name, norad, l1, l2) in geo]
            OUT_GEO.write_text(json.dumps(arr, ensure_ascii=False), encoding="utf-8")
            print(f"src/satellites_geo.json: {len(arr)} 機")
        else:
            print(f"警告: geo {len(geo)} 機は少なすぎる。生成をスキップ。", file=sys.stderr)
    except Exception as e:  # noqa: BLE001
        print(f"警告: geo の取得に失敗 ({e})。スキップ。", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
