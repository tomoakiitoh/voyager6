/* 立体視のエフェクト (赤青アナグリフ / 左右並び) — 太陽系3D (/solar/) で使う。
 *
 * three r160 の examples/jsm/effects/{AnaglyphEffect,StereoEffect}.js を複製したもの。
 * **複製した理由は眼幅を外から変えるため** — 元は StereoCamera がコンストラクタの閉包に
 * 閉じていて、`effect.stereo.eyeSep` に書けない。行列・シェーダ・描画の順番は元のまま。
 * 複製元は three.js (MIT)。表示は /credits/ の three.js の項でカバーしている。
 *
 * このサイトは three を本体 (assets/three.module.min.js) だけ同梱していて examples を持たない。
 * そのため必要な2つだけをここに置く。importmap で `three` が本体に解決される。
 *
 * **元から1点だけ変えたところ**: `setSize()` の `renderer.setSize(w, h)` を
 * `renderer.setSize(w, h, false)` に。太陽系3Dの canvas は CSS で伸ばしているので、
 * updateStyle=true だと inline の px が付いてレイアウトが壊れる (solar の resize() が
 * `setSize(w, h, false)` を使っているのと同じ理由)。
 */
import {
  Matrix3, Mesh, NearestFilter, OrthographicCamera, PlaneGeometry, RGBAFormat,
  Scene, ShaderMaterial, StereoCamera, LinearFilter, Vector2, WebGLRenderTarget,
} from "three";

/** 赤青アナグリフ (左目=赤)。Dubois 行列で色をできるだけ残す。 */
export class AnaglyphEffect {
  constructor(renderer, width = 512, height = 512) {
    // Dubois matrices from https://citeseerx.ist.psu.edu/viewdoc/download?doi=10.1.1.7.6968&rep=rep1&type=pdf#page=4
    this.colorMatrixLeft = new Matrix3().fromArray([
      0.456100, -0.0400822, -0.0152161,
      0.500484, -0.0378246, -0.0205971,
      0.176381, -0.0157589, -0.00546856,
    ]);
    this.colorMatrixRight = new Matrix3().fromArray([
      -0.0434706, 0.378476, -0.0721527,
      -0.0879388, 0.73364, -0.112961,
      -0.00155529, -0.0184503, 1.2264,
    ]);

    const _camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const _scene = new Scene();
    const _stereo = new StereoCamera();
    this.stereo = _stereo;   // ← 複製した理由はこの一行 (呼ぶ側が eyeSep を毎フレーム書く)
    const _params = { minFilter: LinearFilter, magFilter: NearestFilter, format: RGBAFormat };
    const _renderTargetL = new WebGLRenderTarget(width, height, _params);
    const _renderTargetR = new WebGLRenderTarget(width, height, _params);

    const _material = new ShaderMaterial({
      uniforms: {
        "mapLeft": { value: _renderTargetL.texture },
        "mapRight": { value: _renderTargetR.texture },
        "colorMatrixLeft": { value: this.colorMatrixLeft },
        "colorMatrixRight": { value: this.colorMatrixRight },
      },
      vertexShader: [
        "varying vec2 vUv;",
        "void main() {",
        "	vUv = vec2( uv.x, uv.y );",
        "	gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );",
        "}",
      ].join("\n"),
      fragmentShader: [
        "uniform sampler2D mapLeft;",
        "uniform sampler2D mapRight;",
        "varying vec2 vUv;",
        "uniform mat3 colorMatrixLeft;",
        "uniform mat3 colorMatrixRight;",
        "void main() {",
        "	vec2 uv = vUv;",
        "	vec4 colorL = texture2D( mapLeft, uv );",
        "	vec4 colorR = texture2D( mapRight, uv );",
        "	vec3 color = clamp(",
        "			colorMatrixLeft * colorL.rgb +",
        "			colorMatrixRight * colorR.rgb, 0., 1. );",
        "	gl_FragColor = vec4(",
        "			color.r, color.g, color.b,",
        "			max( colorL.a, colorR.a ) );",
        "	#include <tonemapping_fragment>",
        "	#include <colorspace_fragment>",
        "}",
      ].join("\n"),
    });

    const _mesh = new Mesh(new PlaneGeometry(2, 2), _material);
    _scene.add(_mesh);

    this.setSize = function (w, h) {
      renderer.setSize(w, h, false);          // ← 元からの変更点 (上のコメント参照)
      const pixelRatio = renderer.getPixelRatio();
      _renderTargetL.setSize(w * pixelRatio, h * pixelRatio);
      _renderTargetR.setSize(w * pixelRatio, h * pixelRatio);
    };

    this.render = function (scene, camera) {
      const currentRenderTarget = renderer.getRenderTarget();
      if (scene.matrixWorldAutoUpdate === true) scene.updateMatrixWorld();
      if (camera.parent === null && camera.matrixWorldAutoUpdate === true) camera.updateMatrixWorld();
      _stereo.update(camera);
      renderer.setRenderTarget(_renderTargetL);
      renderer.clear();
      renderer.render(scene, _stereo.cameraL);
      renderer.setRenderTarget(_renderTargetR);
      renderer.clear();
      renderer.render(scene, _stereo.cameraR);
      renderer.setRenderTarget(null);
      renderer.render(_scene, _camera);
      renderer.setRenderTarget(currentRenderTarget);
    };

    this.dispose = function () {
      _renderTargetL.dispose();
      _renderTargetR.dispose();
      _mesh.geometry.dispose();
      _mesh.material.dispose();
    };
  }
}

/**
 * 左右並び (左が左目・平行法/Cardboard)。画面を半分ずつに切って2回描くだけで、
 * 合成用の render target は要らない。`stereo` を公開する点は AnaglyphEffect と揃えてある。
 */
export class StereoEffect {
  constructor(renderer) {
    const _stereo = new StereoCamera();
    _stereo.aspect = 0.5;                     // 片目ぶんは横半分
    this.stereo = _stereo;

    const _size = new Vector2();            // 描画先の論理サイズ (毎フレーム new しない)

    this.setSize = function (w, h) {
      renderer.setSize(w, h, false);          // AnaglyphEffect と同じ理由で updateStyle=false
      renderer.getSize(_size);
    };

    this.render = function (scene, camera) {
      if (scene.matrixWorldAutoUpdate === true) scene.updateMatrixWorld();
      if (camera.parent === null && camera.matrixWorldAutoUpdate === true) camera.updateMatrixWorld();
      _stereo.update(camera);

      if (!_size.x || !_size.y) renderer.getSize(_size);   // setSize を呼ばれていなくても動くように
      const w = Math.floor(_size.x / 2), h = _size.y;

      if (renderer.autoClear) renderer.clear();
      renderer.setScissorTest(true);

      renderer.setScissor(0, 0, w, h);
      renderer.setViewport(0, 0, w, h);
      renderer.render(scene, _stereo.cameraL);

      renderer.setScissor(w, 0, w, h);
      renderer.setViewport(w, 0, w, h);
      renderer.render(scene, _stereo.cameraR);

      renderer.setScissorTest(false);
    };
  }
}
