#!/usr/bin/env python3
"""HEALPix ang2pix (nested) の最小実装。

なぜ自前か: 素直には astropy-healpix を使いたいが、この環境の python は
`_lzma` 無しでビルドされていて astropy が import できない。ビルド用スクリプトが
特定の python ビルドに縛られるのは割に合わないので、必要な一関数だけ移植する。

**正しさの担保は tests/fixtures/healpix_ang2pix.json**。astropy-healpix 2.0.1 で
生成した 2,015 点 × nside{16,64,128,256} の基準値で、この実装と JS 側
(src/stars.js の ang2pixNest) の両方を突き合わせる。同じ勘違いを両方に書いても
気づけるよう、基準は**第三者の実装**から採っている。

アルゴリズムは HEALPix C ライブラリの ang2pix_nest そのまま
(Górski et al. 2005, ApJ 622, 759)。赤道帯と極冠で場合分けし、面(0-11)と
面内の (ix, iy) を出してからビットを交互に織り込む。
"""

from __future__ import annotations

import math

# ビット交互織り込み (ix を偶数ビット、iy を奇数ビットへ) の下位16bitぶんの表
_UTAB = [0] * 256
for _m in range(256):
    _v = 0
    for _b in range(8):
        _v |= ((_m >> _b) & 1) << (2 * _b)
    _UTAB[_m] = _v


def _interleave(ix: int, iy: int) -> int:
    """ix,iy (0..2^k-1) を交互ビットで 1 つの整数へ。nside<=2^16 まで。"""
    return (_UTAB[ix & 0xFF] | (_UTAB[(ix >> 8) & 0xFF] << 16)
            | ((_UTAB[iy & 0xFF] | (_UTAB[(iy >> 8) & 0xFF] << 16)) << 1))


def ang2pix_nest(nside: int, ra_deg: float, dec_deg: float) -> int:
    """赤経・赤緯 [度] → HEALPix nested index。nside は 2 のべき。"""
    order = nside.bit_length() - 1
    z = math.sin(math.radians(dec_deg))          # cos(余緯度)
    za = abs(z)
    # 経度を「面の幅 = 90°」単位に。0 <= tt < 4
    tt = (ra_deg % 360.0) / 90.0

    if za <= 2.0 / 3.0:
        # ---- 赤道帯: 面の境界が斜めに走るので、上り線と下り線の番号で面を決める ----
        temp1 = nside * (0.5 + tt)
        temp2 = nside * z * 0.75
        jp = int(temp1 - temp2)                  # 上り (北東向き) の境界線番号
        jm = int(temp1 + temp2)                  # 下り (南東向き) の境界線番号
        ifp = jp >> order
        ifm = jm >> order
        if ifp == ifm:
            face = (ifp & 3) + 4                 # 赤道帯の面 (4-7)
        elif ifp < ifm:
            face = ifp & 3                       # 北の面 (0-3)
        else:
            face = (ifm & 3) + 8                 # 南の面 (8-11)
        ix = jm & (nside - 1)
        iy = nside - (jp & (nside - 1)) - 1
    else:
        # ---- 極冠: 面内は正方格子なので、面の中の相対位置を直接出す ----
        ntt = min(3, int(tt))
        tp = tt - ntt
        tmp = nside * math.sqrt(3.0 * (1.0 - za))
        jp = int(tp * tmp)
        jm = int((1.0 - tp) * tmp)
        jp = min(nside - 1, jp)
        jm = min(nside - 1, jm)
        if z >= 0:
            face = ntt                           # 北極冠 (0-3)
            ix = nside - jm - 1
            iy = nside - jp - 1
        else:
            face = ntt + 8                       # 南極冠 (8-11)
            ix = jp
            iy = jm

    return face * nside * nside + _interleave(ix, iy)


def pix_at_order(pix12: int, nside: int) -> int:
    """level 12 (nside 4096) の nested index を、より粗い nside の index へ落とす。

    nested は「親の index を 4 倍して子を並べる」構造なので、単に右シフトでよい。
    Gaia の source_id >> 35 が level 12 の nested index になっているのを使う。
    """
    order = nside.bit_length() - 1
    return pix12 >> (2 * (12 - order))


def _interleave_np(ix, iy):
    """_interleave の numpy 版 (int64)。"""
    import numpy as np
    tab = np.asarray(_UTAB, dtype=np.int64)
    lo = tab[ix & 0xFF] | (tab[(ix >> 8) & 0xFF] << 16)
    hi = tab[iy & 0xFF] | (tab[(iy >> 8) & 0xFF] << 16)
    return lo | (hi << 1)


def ang2pix_nest_array(nside: int, ra_deg, dec_deg):
    """ang2pix_nest のベクトル版。全天ビルドで効くので numpy で書く。

    スカラ版と同じ式・同じ場合分け。両方を同じ fixture でテストしている。
    """
    import numpy as np
    ra = np.asarray(ra_deg, dtype=np.float64)
    dec = np.asarray(dec_deg, dtype=np.float64)
    order = nside.bit_length() - 1
    z = np.sin(np.radians(dec))
    za = np.abs(z)
    tt = np.mod(ra, 360.0) / 90.0

    eq = za <= 2.0 / 3.0
    face = np.zeros(ra.shape, dtype=np.int64)
    ix = np.zeros(ra.shape, dtype=np.int64)
    iy = np.zeros(ra.shape, dtype=np.int64)

    # ---- 赤道帯 ----
    if eq.any():
        temp1 = nside * (0.5 + tt[eq])
        temp2 = nside * z[eq] * 0.75
        jp = (temp1 - temp2).astype(np.int64)
        jm = (temp1 + temp2).astype(np.int64)
        ifp = jp >> order
        ifm = jm >> order
        f = np.where(ifp == ifm, (ifp & 3) + 4,
                     np.where(ifp < ifm, ifp & 3, (ifm & 3) + 8))
        face[eq] = f
        ix[eq] = jm & (nside - 1)
        iy[eq] = nside - (jp & (nside - 1)) - 1

    # ---- 極冠 ----
    po = ~eq
    if po.any():
        ntt = np.minimum(3, tt[po].astype(np.int64))
        tp = tt[po] - ntt
        tmp = nside * np.sqrt(3.0 * (1.0 - za[po]))
        jp = np.minimum(nside - 1, (tp * tmp).astype(np.int64))
        jm = np.minimum(nside - 1, ((1.0 - tp) * tmp).astype(np.int64))
        north = z[po] >= 0
        face[po] = np.where(north, ntt, ntt + 8)
        ix[po] = np.where(north, nside - jm - 1, jp)
        iy[po] = np.where(north, nside - jp - 1, jm)

    return face * (nside * nside) + _interleave_np(ix, iy)
