#!/usr/bin/env python3
"""20等星図の深層タイル (v1 形式) を作る。

    python3 tools/build_stars_v1.py --source athyg --mag-min 5   # 検証用 (現行と突合)
    python3 tools/build_stars_v1.py --source gaia --files 1      # Gaia を1本だけ
    python3 tools/build_stars_v1.py --source gaia --files all    # 全天 (次弾)

**現行の tools/build_stars.py と dist/stars/ には一切触らない。**
現行は Pages 同梱のフォールバックであり、VR の stars_deep.bin と観測星図の
star_names.json も同じスクリプトが作っているため、壊すと三方向に波及する。
こちらは別ディレクトリ dist/stars_v1/ に出し、クライアントは第2経路として重ねる。

---- なぜこの形式か ----

* **索引は HEALPix nested。** 現行は「緯度10°帯 × cos(dec)比例のRAセル」という自前
  グリッドで、Python と JS が同じセル番号を出せるかが常に不安だった (実際に丸め差で
  取り違えた前例がある)。HEALPix なら等面積で極も特異点にならず、しかも Gaia の
  source_id 上位ビットがそのまま level 12 の nested index なので、**Gaia を読むときは
  座標から計算し直す必要すらない**。
* **層ごとに nside を変える。** 暗い層ほど星が密なので、同じタイルサイズに収めるには
  細かく割る必要がある。層と nside の対応は manifest に書き、**クライアントは
  ハードコードしない**。
* **1星6バイト。** 現行は 10 バイト (ra/dec を f32 生値) だが、タイル内の外接矩形を
  ヘッダに持てば ra/dec は u16 の相対値で足りる。20等まで入れると星数が2桁増えるので、
  ここは効く。分解能はタイルの大きさに比例し、nside 256 のタイルで 0.02° 未満。
* **明るい順に並べる。** クライアントが限界等級で前から切れる (現行と同じ)。

---- 座標の元期 ----
Gaia DR3 は epoch 2016.0。**J2000 に戻さない**。観測用途では現在に近い方が正しく、
16年ぶんの固有運動を全星に適用するのは (誤差を増やすだけで) 割に合わない。
manifest の epoch にそのまま書き、クライアントは今は読むだけ。
"""

from __future__ import annotations

import argparse
import json
import math
import pathlib
import re
import shutil
import struct
import sys
import time
import urllib.request

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import numpy as np
from healpix import ang2pix_nest_array

ROOT = pathlib.Path(__file__).resolve().parent
CACHE = ROOT / "cache"
GAIA_CACHE = CACHE / "gaia"
DIST = ROOT.parent / "dist"
OUTDIR = DIST / "stars_v1"
TMPDIR = DIST / "stars_v1.tmp"

GAIA_BASE = "https://cdn.gea.esac.esa.int/Gaia/gdr3/gaia_source/"
GAIA_MD5 = GAIA_BASE + "_MD5SUM.txt"
GAIA_FILES_TOTAL = 3386          # _MD5SUM.txt のデータファイル数 (全天見積りに使う)

# 層: (id, 等級下限(排他), 等級上限(含む), nside)
LAYERS = [("L3", 10.0, 13.0, 16),
          ("L4", 13.0, 16.0, 64),
          ("L5", 16.0, 18.5, 128),
          ("L6", 18.5, 21.0, 256)]

COL_LO, COL_HI = -1.0, 5.0       # BP-RP (AT-HYG 検証時は B-V をそのまま入れる)
PM_THRESHOLD = 200.0             # mas/yr。これを超える星はタイルから外し highpm.json へ
PM_MAG_LIMIT = 15.0              # ただし G>15 は固有運動を無視してタイルに入れる
                                 # (20等級の星の μ は星図の見え方に効かない。全天で
                                 #  highpm.json が肥大するのを防ぐ方が大事)

HEADER = struct.Struct("<ffff")  # ra0, dec0, raSpan, decSpan
RECORD = struct.Struct("<HHBB")  # dra, ddec, magQ, colQ


# ---------------------------------------------------------------- タイル書き出し

def _ra_bounds(ra: np.ndarray) -> tuple[float, float]:
    """RA の外接区間 (west, span)。RA=0 をまたぐ場合に対応する。

    タイル内の星は空で連続しているので、RA を並べたときの**最大の隙間**の
    直後が西端になる。0/360 をまたぐタイルではこの隙間が 0 のあたりに来ない。
    """
    if ra.size == 1:
        return float(ra[0]), 0.0
    s = np.sort(ra)
    gaps = np.diff(s)
    wrap_gap = (s[0] + 360.0) - s[-1]
    i = int(np.argmax(gaps)) if gaps.size else -1
    if i >= 0 and gaps[i] > wrap_gap:
        west = float(s[i + 1])
        span = float((s[i] + 360.0) - s[i + 1])
    else:
        west = float(s[0])
        span = float(s[-1] - s[0])
    return west, span


def write_tile(path: pathlib.Path, ra, dec, mag, col, mag_lo, mag_hi) -> int:
    """1タイルを書く。レコードは明るい順。戻り値はバイト数。"""
    order = np.argsort(mag, kind="stable")
    ra, dec, mag, col = ra[order], dec[order], mag[order], col[order]

    ra0, ra_span = _ra_bounds(ra)
    dec0 = float(dec.min())
    dec_span = float(dec.max() - dec0)

    # 相対量へ。span=0 (星が1個/同一値) のときは全部 0 に倒す
    def q16(v, lo, span):
        if span <= 0:
            return np.zeros(v.shape, dtype=np.uint16)
        return np.clip(np.rint((v - lo) / span * 65535), 0, 65535).astype(np.uint16)

    dra_src = np.mod(ra - ra0, 360.0)
    dra = q16(dra_src, 0.0, ra_span)
    ddec = q16(dec, dec0, dec_span)
    magq = np.clip(np.rint((mag - mag_lo) / (mag_hi - mag_lo) * 255), 0, 255).astype(np.uint8)
    colq = np.clip(np.rint((col - COL_LO) / (COL_HI - COL_LO) * 255), 0, 255).astype(np.uint8)

    buf = bytearray(HEADER.pack(ra0, dec0, ra_span, dec_span))
    rec = np.empty(len(ra), dtype=[("a", "<u2"), ("b", "<u2"), ("c", "u1"), ("d", "u1")])
    rec["a"], rec["b"], rec["c"], rec["d"] = dra, ddec, magq, colq
    buf += rec.tobytes()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(buf)
    return len(buf)


# ---------------------------------------------------------------- 入力の正規化

def load_athyg(mag_min: float):
    """AT-HYG v4.0 (m10 サブセット) を読む。検証専用。"""
    import csv
    import gzip
    src = CACHE / "athyg_40_reduced_m10.csv.gz"
    if not src.exists():
        sys.exit(f"エラー: {src} が無い。先に tools/build_stars.py を一度実行してください。")
    ra, dec, mag, col, pmra, pmdec = [], [], [], [], [], []
    with gzip.open(src, "rt", encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            try:
                m = float(row["mag"])
                r = float(row["ra"]) * 15.0      # AT-HYG の ra は「時」
                d = float(row["dec"])
            except (TypeError, ValueError, KeyError):
                continue
            if not (mag_min < m):
                continue
            ra.append(r); dec.append(d); mag.append(m)
            try:
                col.append(float(row.get("ci") or 0.0))
            except ValueError:
                col.append(0.0)
            try:
                pmra.append(float(row.get("pmra") or 0.0))
                pmdec.append(float(row.get("pmdec") or 0.0))
            except ValueError:
                pmra.append(0.0); pmdec.append(0.0)
    return (np.array(ra), np.array(dec), np.array(mag), np.array(col),
            np.array(pmra), np.array(pmdec), None)


def gaia_file_list() -> list[str]:
    """_MD5SUM.txt からデータファイル名の一覧を取る (索引 HTML より確実)。"""
    p = GAIA_CACHE / "_MD5SUM.txt"
    if not p.exists():
        GAIA_CACHE.mkdir(parents=True, exist_ok=True)
        print(f"  _MD5SUM.txt を取得: {GAIA_MD5}")
        urllib.request.urlretrieve(GAIA_MD5, p)
    names = re.findall(r"GaiaSource_\d+-\d+\.csv\.gz", p.read_text())
    return sorted(set(names))


def pick_dense_file(names: list[str]) -> str:
    """銀河面 (いて座付近 l≈20°, b≈0°) を含むファイル。密度最悪ケースを最初に見る。

    ファイル名の数値は HEALPix level 8 (nside 256) の nested index の範囲。
    Gaia は 1 ファイルの行数がおおよそ揃うように切っているので、**担当セル数が
    少ないファイルほど密**になる。
    """
    from healpix import ang2pix_nest
    ra, dec = 276.8823, -11.4886          # l=20, b=0 の ICRS (astropy で換算した値)
    target = ang2pix_nest(256, ra, dec)
    for n in names:
        a, b = map(int, re.findall(r"\d+", n)[:2])
        if a <= target <= b:
            return n
    return names[len(names) // 2]


def load_gaia(paths: list[pathlib.Path], verify: bool):
    """Gaia の csv.gz を DuckDB で読む。列は必要な7つだけ射影する。"""
    import duckdb
    con = duckdb.connect()
    files = "[" + ",".join(f"'{p.as_posix()}'" for p in paths) + "]"
    # Gaia の csv.gz は ECSV で、先頭に # のメタ行が1000行ある。comment='#' で飛ばす。
    # Gaia の ECSV は欠損を**文字列 'null'** で書くので、nullstr で教えないと
    # 数値列が VARCHAR に落ちる。念のため TRY_CAST も噛ませて、想定外の値は
    # NULL に倒す (1行の異常で全天ビルドが止まる方が困る)。
    q = f"""
      SELECT CAST(source_id AS BIGINT)          AS source_id,
             TRY_CAST(ra              AS DOUBLE) AS ra,
             TRY_CAST(dec             AS DOUBLE) AS dec,
             TRY_CAST(pmra            AS DOUBLE) AS pmra,
             TRY_CAST(pmdec           AS DOUBLE) AS pmdec,
             TRY_CAST(phot_g_mean_mag AS DOUBLE) AS phot_g_mean_mag,
             TRY_CAST(bp_rp           AS DOUBLE) AS bp_rp
      FROM read_csv({files}, compression='gzip', comment='#', header=true,
                    nullstr='null', sample_size=200000)
      WHERE TRY_CAST(phot_g_mean_mag AS DOUBLE) IS NOT NULL
        AND TRY_CAST(ra AS DOUBLE) IS NOT NULL
        AND TRY_CAST(dec AS DOUBLE) IS NOT NULL
    """
    t = time.time()
    # fetchnumpy は pyarrow を要らない (依存を増やさない)。NULL のある列は
    # masked array で返るので、fill で既定値に倒す。
    d = con.execute(q).fetchnumpy()
    print(f"  DuckDB 読み込み {len(d['ra']):,} 行  ({time.time()-t:.1f}s)")

    def col_of(name, fill):
        a = d[name]
        if hasattr(a, "filled"):
            a = a.filled(fill)
        a = np.asarray(a, dtype=np.float64)
        return np.where(np.isnan(a), fill, a)

    sid = np.asarray(getattr(d["source_id"], "filled", lambda v: d["source_id"])(0),
                     dtype=np.int64)
    ra = col_of("ra", 0.0)
    dec = col_of("dec", 0.0)
    mag = col_of("phot_g_mean_mag", 99.0)
    col = col_of("bp_rp", 1.0)                       # BP-RP 無しは淡黄色 (+1.0) 扱い
    pmra = col_of("pmra", 0.0)
    pmdec = col_of("pmdec", 0.0)

    if verify:
        # source_id 由来の pix と、ra/dec から解いた ang2pix が一致するか全件検算。
        # 一致しないなら ra/dec 側を正とする (座標が真、source_id は割り当ての履歴)。
        pix12 = sid >> 35
        for nside in (16, 256):
            shift = 2 * (12 - (nside.bit_length() - 1))
            from_id = pix12 >> shift
            from_ang = ang2pix_nest_array(nside, ra, dec)
            same = int((from_id == from_ang).sum())
            print(f"  source_id 由来 pix vs ang2pix (nside={nside}): "
                  f"{same:,}/{len(ra):,} = {same/len(ra)*100:.4f}% 一致")
    return ra, dec, mag, col, pmra, pmdec, sid


# ---------------------------------------------------------------- 本体

def build(args) -> int:
    t_all = time.time()
    if args.source == "athyg":
        print("入力: AT-HYG v4.0 (検証用)")
        ra, dec, mag, col, pmra, pmdec, sid = load_athyg(args.mag_min)
        epoch, source_id_name = 2000.0, "athyg-40"
    else:
        names = gaia_file_list()
        print(f"Gaia データファイル数: {len(names):,}")
        if args.files == "all":
            picked = names
        else:
            picked = [pick_dense_file(names)]
        paths = []
        for n in picked:
            p = GAIA_CACHE / n
            if not p.exists():
                print(f"  取得中: {n}")
                GAIA_CACHE.mkdir(parents=True, exist_ok=True)
                urllib.request.urlretrieve(GAIA_BASE + n, p)
            print(f"  使用: {n} ({p.stat().st_size/1e6:.1f} MB)")
            paths.append(p)
        ra, dec, mag, col, pmra, pmdec, sid = load_gaia(paths, verify=True)
        epoch, source_id_name = 2016.0, "gaia-dr3"

    n_in = len(ra)
    print(f"入力星数: {n_in:,}")

    # 高固有運動星はタイルから外す (クライアントが日付ぶん動かして描く)。
    # ただし暗い星は除外しない — 全天で highpm.json が肥大するのを避けるため。
    mu = np.hypot(pmra, pmdec)
    hp_mask = (mu > PM_THRESHOLD) & (mag <= PM_MAG_LIMIT)
    print(f"高固有運動 (|μ|>{PM_THRESHOLD} mas/yr かつ G<={PM_MAG_LIMIT}): {int(hp_mask.sum()):,} 星")

    mag_lo_first = args.mag_min if args.source == "athyg" else LAYERS[0][1]
    layers = [(lid, (mag_lo_first if i == 0 else lo), hi, ns)
              for i, (lid, lo, hi, ns) in enumerate(LAYERS)]

    if TMPDIR.exists():
        shutil.rmtree(TMPDIR)
    TMPDIR.mkdir(parents=True)

    tiles_index: dict[str, list[int]] = {}
    total_bytes = 0
    max_tile = (0, "")
    keep = ~hp_mask
    for lid, lo, hi, nside in layers:
        m = keep & (mag > lo) & (mag <= hi)
        cnt = int(m.sum())
        if cnt == 0:
            tiles_index[lid] = []
            print(f"  {lid} ({lo}, {hi}] nside={nside}: 星なし")
            continue
        lra, ldec, lmag, lcol = ra[m], dec[m], mag[m], col[m]
        pix = ang2pix_nest_array(nside, lra, ldec)
        order = np.argsort(pix, kind="stable")
        pix, lra, ldec, lmag, lcol = pix[order], lra[order], ldec[order], lmag[order], lcol[order]
        uniq, starts = np.unique(pix, return_index=True)
        ends = np.append(starts[1:], len(pix))
        lbytes = 0
        for p, s, e in zip(uniq, starts, ends):
            nb = write_tile(TMPDIR / lid / f"{int(p)}.bin",
                            lra[s:e], ldec[s:e], lmag[s:e], lcol[s:e], lo, hi)
            lbytes += nb
            if nb > max_tile[0]:
                max_tile = (nb, f"{lid}/{int(p)}.bin ({e-s:,}星)")
        tiles_index[lid] = [int(x) for x in uniq]
        total_bytes += lbytes
        print(f"  {lid} ({lo}, {hi}] nside={nside}: {cnt:,} 星 / "
              f"{len(uniq):,} タイル / {lbytes/1e6:.1f} MB")

    # 高固有運動星 (形式は現行 highpm.json と同じ [ra, dec, pmra, pmdec, mag, col])
    hp = [[round(float(ra[i]), 6), round(float(dec[i]), 6),
           round(float(pmra[i]), 2), round(float(pmdec[i]), 2),
           round(float(mag[i]), 3), round(float(col[i]), 3)]
          for i in np.nonzero(hp_mask)[0]]
    (TMPDIR / "highpm.json").write_text(json.dumps(hp, separators=(",", ":")))

    manifest = {
        "version": 1,
        "scheme": "healpix-nested",
        "epoch": epoch,
        "recordBytes": RECORD.size,
        "headerBytes": HEADER.size,
        "colRange": [COL_LO, COL_HI],
        "layers": [{"id": lid, "magMin": lo, "magMax": hi, "nside": ns,
                    "source": source_id_name} for lid, lo, hi, ns in layers],
        "tiles": tiles_index,
        "sources": {
            # ライセンスは ESA 公式頁で確認した実測値 (2026-08-29)。
            # https://www.cosmos.esa.int/web/gaia-users/license
            # 指示書は "CC BY 4.0" としていたが誤り。**NC (非商用)** なので、
            # サイト本体の CC BY-SA 4.0 でそのまま再配布することはできない。
            # 配信形態が決まるまで、この manifest に正しい条件を書いておく。
            "gaia-dr3": {
                "name": "Gaia DR3", "license": "CC BY-NC 3.0 IGO",
                "license_url": "https://creativecommons.org/licenses/by-nc/3.0/igo/",
                "credit": ("This work has made use of data from the European Space Agency "
                           "(ESA) mission Gaia (https://www.cosmos.esa.int/gaia), processed "
                           "by the Gaia Data Processing and Analysis Consortium (DPAC, "
                           "https://www.cosmos.esa.int/web/gaia/dpac/consortium).")},
            "athyg-40": {"name": "AT-HYG v4.0", "license": "CC BY-SA 4.0"},
        },
        "coverage": "full" if (args.source == "gaia" and args.files == "all") else "partial",
        "note": ("極のタイルは raSpan が 360 になり得るので RA の分解能は 360/65535=0.0055°。"
                 "cos(dec) を掛けた実距離は nside 256 の極タイルで 0.5 秒角未満なので許容する。"),
    }
    (TMPDIR / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False))
    total_bytes += (TMPDIR / "manifest.json").stat().st_size
    total_bytes += (TMPDIR / "highpm.json").stat().st_size

    # アトミックに差し替え (途中で落ちても前回分が残る)
    if OUTDIR.exists():
        shutil.rmtree(OUTDIR)
    TMPDIR.rename(OUTDIR)

    dt = time.time() - t_all
    n_tiles = sum(len(v) for v in tiles_index.values())
    print(f"\n出力 {OUTDIR}: {n_tiles:,} タイル / {total_bytes/1e6:.1f} MB / {dt:.1f}s")
    print(f"最大タイル: {max_tile[1]} = {max_tile[0]/1e6:.2f} MB")
    if args.source == "gaia" and args.files != "all":
        print(f"全天見積り (×{GAIA_FILES_TOTAL}): "
              f"{total_bytes*GAIA_FILES_TOTAL/1e9:.1f} GB / "
              f"{dt*GAIA_FILES_TOTAL/3600:.1f} 時間  ※銀河面の最悪ケース基準なので上振れ")
    if args.delete_after and args.source == "gaia":
        for p in paths:
            p.unlink(missing_ok=True)
            print(f"  削除: {p.name}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="20等星図の深層タイル (v1) を作る")
    ap.add_argument("--source", choices=["athyg", "gaia"], required=True)
    ap.add_argument("--files", default="1", help="gaia のとき: 1 か all")
    ap.add_argument("--mag-min", type=float, default=10.0,
                    help="最初の層の下限等級。AT-HYG 検証時は 5 に下げる")
    ap.add_argument("--delete-after", action="store_true",
                    help="処理後に csv.gz を消す (全天時のディスク対策)")
    return build(ap.parse_args())


if __name__ == "__main__":
    sys.exit(main())
