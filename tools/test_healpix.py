#!/usr/bin/env python3
"""tools/healpix.py を fixture (astropy-healpix 由来) に対して固定する。

    python3 tools/test_healpix.py

JS 側 (tests/stars_v1.test.mjs) と**同じ fixture**を見ている。両方を第三者の
基準に当てることで、同じ勘違いを二重に書いても気づける。
"""
import json, pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import numpy as np
from healpix import ang2pix_nest, ang2pix_nest_array

fx = json.loads((pathlib.Path(__file__).resolve().parent.parent
                 / "tests/fixtures/healpix_ang2pix.json").read_text())
ties = set(fx["ties"])
lon, lat = np.array(fx["lon"]), np.array(fx["lat"])
fail = 0
for ns, ref in fx["pix"].items():
    nside = int(ns)
    vec = ang2pix_nest_array(nside, lon, lat)
    for i, r in enumerate(ref):
        if i in ties:
            continue
        s = ang2pix_nest(nside, lon[i], lat[i])
        if s != r or int(vec[i]) != r:
            fail += 1
            if fail <= 5:
                print(f"  不一致 nside={nside} lon={lon[i]} lat={lat[i]}: "
                      f"スカラ={s} ベクトル={int(vec[i])} 基準={r}")
    print(f"nside={nside:4d}: 検証 {len(ref)-len(ties)} 点")
print("NG" if fail else "OK: スカラ版・ベクトル版とも fixture と一致 (同点3点を除く)")
sys.exit(1 if fail else 0)
