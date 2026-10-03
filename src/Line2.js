/* three r160 examples/jsm/lines/Line2.js をそのまま複製したもの (three.js · MIT)。
   このサイトは three を本体だけ同梱していて examples を持たないので、立体視で使う太線のぶんだけ置く。
   **変更は import のパスだけ** ('../lines/X.js' → './X.js'。assets/ は平らに並ぶため)。
   なぜ要るか: WebGL では LineBasicMaterial の linewidth が効かず線は常に1物理ピクセルで、
   赤青めがねだと片目に届く色が1チャンネルになってさらに細く暗く見える (/solar/?stereo=rc)。 */
import { LineSegments2 } from './LineSegments2.js';
import { LineGeometry } from './LineGeometry.js';
import { LineMaterial } from './LineMaterial.js';

class Line2 extends LineSegments2 {

	constructor( geometry = new LineGeometry(), material = new LineMaterial( { color: Math.random() * 0xffffff } ) ) {

		super( geometry, material );

		this.isLine2 = true;

		this.type = 'Line2';

	}

}

export { Line2 };
