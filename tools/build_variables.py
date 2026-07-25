#!/usr/bin/env python3
"""著名変光星のシードカタログを生成する (観測星図モード F2b)。

    python3 tools/build_variables.py

観測星図で target=<変光星名> を解決し、比較星選定で「変光星を比較星から除外」するのに使う。
GCVS(モスクワ大 Sternberg研)の主要変光星のうち、肉眼〜双眼鏡級の著名なものを手選 (全収録はしない)。
座標は J2000。等級は V の代表的な最大(明)〜最小(暗)。値は目安 (詳細な測光は AAVSO VSP)。

出力 src/variables.json = JSON 配列、1件 = [name, ra(deg), dec(deg), type, magMax, magMin, period|null, note]

出典: GCVS (Samus+ 2017, 伝統的に学術・自由利用/要出典)。※観測用の較正シーケンスは含めない(AAVSO VSPへ送客)。
"""

from __future__ import annotations

import json
import pathlib

OUT = pathlib.Path(__file__).resolve().parent.parent / "src" / "variables.json"

# [name, ra, dec, type, magMax, magMin, period, note]
VARIABLES = [
    ["T CrB",   239.8757,  25.9202, "NR",   2.0, 10.8, None,   "かんむり座。再帰新星、2024年から爆発待機中"],
    ["Mira",     34.8366,  -2.9776, "M",    2.0, 10.1, 332.0,  "くじら座(ο Cet)。長周期変光星の代表"],
    ["Algol",    47.0422,  40.9556, "EA",   2.12, 3.39, 2.867, "ペルセウス座(β Per)。食変光星の代表=悪魔の星"],
    ["delta Cep",337.2929, 58.4152, "DCEP", 3.48, 4.37, 5.366, "ケフェウス座(δ Cep)。古典的セファイドの原型"],
    ["beta Lyr", 282.5199, 33.3627, "EB",   3.25, 4.36, 12.94, "こと座(β Lyr)=シェリアク。接触に近い食連星"],
    ["chi Cyg",  297.6413, 32.9141, "M",    3.3, 14.2, 408.0,  "はくちょう座(χ Cyg)。振幅の大きいミラ型"],
    ["gamma Cas", 14.1772, 60.7167, "GCAS", 1.6,  3.0, None,   "カシオペヤ座(γ Cas)。輝線星(殻)変光の原型"],
    ["R CrB",    237.1433, 28.1568, "RCB",  5.7, 14.8, None,   "かんむり座R。不規則に深く減光する炭素星"],
    ["Betelgeuse",88.7929,  7.4071, "SRC",  0.0,  1.6, None,   "オリオン座(α Ori)。2019-20年の大減光で話題"],
    ["Antares", 247.3519, -26.4320, "LC",   0.88, 1.16, None,  "さそり座(α Sco)。赤色超巨星"],
    ["mu Cep",  325.8788,  58.7801, "SRC",  3.43, 5.1, None,   "ケフェウス座(μ Cep)。ハーシェルのざくろ星"],
    ["zeta Gem",106.0271,  20.5703, "DCEP", 3.62, 4.18, 10.15, "ふたご座(ζ Gem)=メブスタ。肉眼セファイド"],
    ["eta Aql", 298.1181,   1.0057, "DCEP", 3.48, 4.39, 7.177, "わし座(η Aql)。肉眼セファイド"],
    ["RR Lyr",  291.3663,  42.7844, "RRAB", 7.06, 8.12, 0.567, "こと座RR。RRライリー型の原型"],
    ["SS Cyg",  325.6789,  43.5861, "UGSS", 8.2, 12.4, None,   "はくちょう座。矮新星の代表"],
    ["U Gem",   118.7717,  22.0014, "UGSS", 8.2, 14.9, None,   "ふたご座U。矮新星の原型"],
    ["R Leo",   146.8896,  11.4289, "M",    4.4, 11.3, 310.0,  "しし座R。明るいミラ型"],
    ["R Hya",   202.4283, -23.2813, "M",    3.5, 10.9, 380.0,  "うみへび座R。明るいミラ型"],
    ["R Sct",   281.8704,  -5.7051, "RVA",  4.2,  8.6, 146.0,  "たて座R。RVタウリ型の代表"],
    ["epsilon Aur",75.4921,43.8233, "EA",   2.92, 3.83, 9890.0,"ぎょしゃ座(ε Aur)。約27年周期の謎の食連星"],
    ["P Cyg",   304.4467,  38.0330, "SDOR", 3.0,  6.0, None,   "はくちょう座P(34 Cyg)。高光度青色変光星"],
    ["delta Sco",240.0833,-22.6217, "GCAS", 1.6,  2.3, None,   "さそり座(δ Sco)=ジュバ。2000年に増光"],
    ["R Aql",   286.5929,   8.2300, "M",    5.5, 12.0, 270.0,  "わし座R。ミラ型"],
]


def main() -> int:
    OUT.write_text(json.dumps(VARIABLES, ensure_ascii=False, separators=(",", ":")),
                   encoding="utf-8")
    print(f"src/variables.json: {len(VARIABLES)} 件 ({OUT.stat().st_size:,} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
