import * as THREE from "three";

/* VR 内の操作パネル (VRプラネタリウム / 地球周回3D で共有)。

   考え方: パネルは状態を持たない。行を押したら画面下の既存の入力要素を click() するだけで、
   状態の持ち主はいつも DOM 側ひとつ。こうしておくと VR とデスクトップで設定が食い違わない。

   構成:
     - パネル本体 … コントローラのレイで指してトリガーで押す。B/Y で開閉
     - ステータス表示 … パネルを閉じていても常に見える細い帯。日時や選択中の天体を出す
       (VR で早送りすると「何時で止まったのか」が分からなくなるため)
     - レイがパネルを外したときは onMiss に渡すので、ページ側で天体の掴み取りに使える

   ヘッドセットが無くても確認できるよう、マウスを同じレイとして扱う道も用意してある
   (preview: true)。 */

const W = 512;          // パネルのテクスチャ幅 [px]
const ROW = 62;         // 1行の高さ [px]
const TOP = 78;         // 1行目の上端 [px]
const BOTTOM = 20;      // 下の余白 [px]
const STATUS_H = 74;    // ステータス帯の高さ [px]

function rr(g, x, y, w, h, r) {
  if (g.roundRect) { g.beginPath(); g.roundRect(x, y, w, h, r); return; }
  g.beginPath(); g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}

/** キャンバス1枚 + それを貼った板。テクスチャは中身が変わったときだけ更新する。 */
function makeBoard(hPx, worldW) {
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = hPx;
  const tex = new THREE.CanvasTexture(canvas);
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(worldW, worldW * hPx / W),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true,
                                  depthTest: false, depthWrite: false }));
  mesh.renderOrder = 9000;      // ラベル類が depthTest:false なので最後に描いて手前に出す
  return { canvas, ctx: canvas.getContext("2d"), tex, mesh };
}

export class VrPanel {
  /**
   * @param {object} o
   * @param {THREE.WebGLRenderer} o.renderer
   * @param {THREE.Scene} o.scene
   * @param {THREE.Camera} o.camera      デスクトップ確認用のカメラ
   * @param {Array} o.rows               [{id:"チェックボックスのid", label}] または [{act:"ボタンのid", label}]
   * @param {string} [o.title]
   * @param {function} [o.status]        毎フレーム呼ばれ、ステータス帯に出す文字列を返す
   * @param {function} [o.onMiss]        レイがパネルを外したとき (raycaster, controller) で呼ばれる
   * @param {HTMLElement} [o.domTarget]  マウス操作を受けるキャンバス (デスクトップ確認用)
   * @param {boolean} [o.preview]        true でヘッドセット無しでも出す
   */
  constructor(o) {
    this.o = o;
    this.rows = o.rows;
    this.el = (id) => document.getElementById(id);
    this.hover = -1;
    this.controllers = [];
    this._ray = new THREE.Raycaster();
    this._m4 = new THREE.Matrix4();
    this._lastStatus = null;

    const hPx = TOP + this.rows.length * ROW + BOTTOM;
    this.board = makeBoard(hPx, 0.62);
    this.board.mesh.visible = false;
    o.scene.add(this.board.mesh);

    this.status = makeBoard(STATUS_H, 0.62);
    this.status.mesh.visible = false;
    this.status.mesh.renderOrder = 9000;
    o.scene.add(this.status.mesh);

    this.draw();

    // 画面下の入力で切り替えたときも、パネルの ON/OFF 表示を合わせる
    for (const r of this.rows) {
      const e = this.el(r.id || r.act);
      if (e) e.addEventListener(r.id ? "change" : "click", () => this.draw());
    }

    if (o.domTarget) this._bindMouse(o.domTarget);
    if (o.preview) { this.setVisible(true); this.setStatusVisible(true); }
  }

  get visible() { return this.board.mesh.visible; }

  // ---- 描画 ----
  draw() {
    const g = this.board.ctx, H = this.board.canvas.height;
    g.clearRect(0, 0, W, H);
    rr(g, 1, 1, W - 2, H - 2, 20);
    g.fillStyle = "rgba(8,13,26,0.94)"; g.fill();
    g.strokeStyle = "#35589c"; g.lineWidth = 2; g.stroke();
    g.textBaseline = "middle";
    g.fillStyle = "#e6eeff"; g.font = "bold 27px sans-serif";
    g.fillText(this.o.title || "表示設定", 26, 42);
    g.fillStyle = "#7c88a3"; g.font = "16px sans-serif";
    g.textAlign = "right"; g.fillText("B / Y ボタンで開閉", W - 26, 42); g.textAlign = "left";

    this.rows.forEach((r, i) => {
      const y = TOP + i * ROW;
      const box = this.el(r.id);
      const on = r.id ? !!(box && box.checked) : false;
      rr(g, 18, y, W - 36, ROW - 8, 11);
      g.fillStyle = i === this.hover ? "rgba(53,88,156,0.65)" : "rgba(19,27,48,0.92)"; g.fill();
      g.strokeStyle = on ? "#35589c" : "#1d2437"; g.lineWidth = 1.5; g.stroke();
      g.fillStyle = r.act ? "#cfe0ff" : (on ? "#e6eeff" : "#7c88a3");
      g.font = "22px sans-serif";
      g.fillText(r.label, 40, y + (ROW - 8) / 2);
      if (r.id) {
        const pw = 62, px = W - 36 - pw - 14;
        rr(g, px, y + 12, pw, 30, 15);
        g.fillStyle = on ? "#23407a" : "#131b30"; g.fill();
        g.strokeStyle = on ? "#6ea8ff" : "#2a3450"; g.lineWidth = 1.5; g.stroke();
        g.fillStyle = on ? "#e6eeff" : "#6b7890"; g.font = "bold 16px sans-serif";
        g.textAlign = "center"; g.fillText(on ? "ON" : "OFF", px + pw / 2, y + 27);
        g.textAlign = "left";
      }
    });
    this.board.tex.needsUpdate = true;
  }

  drawStatus(text) {
    if (text === this._lastStatus) return;
    this._lastStatus = text;
    const g = this.status.ctx;
    g.clearRect(0, 0, W, STATUS_H);
    rr(g, 1, 1, W - 2, STATUS_H - 2, 14);
    g.fillStyle = "rgba(8,13,26,0.88)"; g.fill();
    g.strokeStyle = "#25406e"; g.lineWidth = 2; g.stroke();
    g.textBaseline = "middle"; g.textAlign = "center";
    // 長い行は 2段に折る (衛星名＋諸元が入るため)
    const lines = String(text || "").split("\n").slice(0, 2);
    // 収まる大きさまで縮める。それでも溢れるなら末尾を省略する
    const fit = (t, base, min) => {
      for (let px = base; px >= min; px -= 1) {
        g.font = px + "px sans-serif";
        if (g.measureText(t).width <= W - 36) return t;
      }
      let cut = t;
      while (cut.length > 4 && g.measureText(cut + "…").width > W - 36) cut = cut.slice(0, -1);
      return cut + "…";
    };
    g.fillStyle = "#dbe4f7";
    if (lines.length === 1) {
      g.fillText(fit(lines[0], 24, 15), W / 2, STATUS_H / 2);
    } else {
      g.fillText(fit(lines[0], 22, 14), W / 2, STATUS_H / 2 - 15);
      g.fillStyle = "#9fb0cd";
      g.fillText(fit(lines[1], 18, 11), W / 2, STATUS_H / 2 + 16);
    }
    g.textAlign = "left";
    this.status.tex.needsUpdate = true;
  }

  // ---- 配置 ----
  /** 視線の正面 (水平方向) に置く。見上げていても足元に回り込まないようにする。 */
  place() {
    const xr = this.o.renderer.xr;
    const cam = xr.isPresenting ? xr.getCamera() : this.o.camera;
    if (this.o.beforePlace) this.o.beforePlace();
    cam.updateMatrixWorld();
    const p = new THREE.Vector3(), q = new THREE.Quaternion();
    cam.getWorldPosition(p); cam.getWorldQuaternion(q);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
    fwd.normalize();
    const side = new THREE.Vector3(-fwd.z, 0, fwd.x);   // 視線の左右方向
    const at = (mesh, dy, dx) => {
      mesh.position.copy(p).addScaledVector(fwd, 1.3).addScaledVector(side, dx || 0);
      mesh.position.y = p.y + dy;
      mesh.lookAt(p);
    };
    at(this.board.mesh, -0.02, this.o.panelOffsetX || 0);
    at(this.status.mesh, -0.52, 0);       // パネルの下 (追従しない場合の位置)
  }

  /** ステータス帯を視線の少し下に貼り付ける (頭に追従)。
      早送り中は空を見ているので、世界に固定すると日時を見失う。視界の下端なら
      視線を外さずに読めて、中央は塞がない。 */
  _followStatus() {
    const xr = this.o.renderer.xr;
    const cam = xr.isPresenting ? xr.getCamera() : this.o.camera;
    cam.updateMatrixWorld();
    const p = new THREE.Vector3(), q = new THREE.Quaternion();
    cam.getWorldPosition(p); cam.getWorldQuaternion(q);
    const dir = new THREE.Vector3(0, -0.42, -1).normalize().applyQuaternion(q);
    this.status.mesh.position.copy(p).addScaledVector(dir, 1.2);
    this.status.mesh.quaternion.copy(q);
  }

  setVisible(v) {
    this.board.mesh.visible = v;
    if (v) { this.place(); this.hover = -1; this.draw(); }
  }
  toggle() { this.setVisible(!this.visible); }

  /** ステータス帯だけは VR に入っている間ずっと出しておく。 */
  setStatusVisible(v) { this.status.mesh.visible = v; if (v) this.place(); }

  // ---- 当たり判定 ----
  _rowFromUv(uv) {
    const H = this.board.canvas.height;
    const y = (1 - uv.y) * H;                   // uv は下が0、canvas は上が0
    const i = Math.floor((y - TOP) / ROW);
    return (y >= TOP && i >= 0 && i < this.rows.length) ? i : -1;
  }
  _hitFromController(c) {
    this._m4.identity().extractRotation(c.matrixWorld);
    this._ray.ray.origin.setFromMatrixPosition(c.matrixWorld);
    this._ray.ray.direction.set(0, 0, -1).applyMatrix4(this._m4);
    return this.board.mesh.visible
      ? (this._ray.intersectObject(this.board.mesh, false)[0] || null) : null;
  }
  activate(i) {
    const r = this.rows[i];
    if (!r) return;
    const e = this.el(r.id || r.act);
    if (e) e.click();                            // 既存のハンドラをそのまま動かす
    this.draw();
  }

  // ---- コントローラ ----
  mountControllers() {
    if (this.controllers.length) return;
    const { renderer, scene } = this.o;
    for (const i of [0, 1]) {
      const c = renderer.xr.getController(i);
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(
          [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]),
        new THREE.LineBasicMaterial({ color: 0x6ea8ff, transparent: true,
                                      opacity: 0.85, depthTest: false }));
      line.renderOrder = 9001; line.scale.z = 3;
      c.add(line);
      c.addEventListener("selectstart", () => {
        const hit = this._hitFromController(c);
        if (hit) {
          const r = this._rowFromUv(hit.uv);
          if (r >= 0) { this.activate(r); return; }
        }
        if (this.o.onMiss) this.o.onMiss(this._ray, c);   // パネル外 = ページ側の掴み取りへ
      });
      scene.add(c);
      this.controllers.push(c);
    }
  }

  /** 毎フレーム呼ぶ: レイのホバー表示とステータスの更新。 */
  update() {
    if (this.o.status) this.drawStatus(this.o.status());
    if (this.status.mesh.visible) this._followStatus();
    if (!this.o.renderer.xr.isPresenting || !this.board.mesh.visible) return;
    let h = -1;
    for (const c of this.controllers) {
      const hit = this._hitFromController(c);
      if (hit) { h = this._rowFromUv(hit.uv); break; }
    }
    if (h !== this.hover) { this.hover = h; this.draw(); }
  }

  // ---- ヘッドセット無しでの確認用 ----
  _bindMouse(target) {
    const hit = (e) => {
      const r = target.getBoundingClientRect();
      this._ray.setFromCamera(new THREE.Vector2(
        ((e.clientX - r.left) / r.width) * 2 - 1,
        -((e.clientY - r.top) / r.height) * 2 + 1), this.o.camera);
      return this.board.mesh.visible
        ? (this._ray.intersectObject(this.board.mesh, false)[0] || null) : null;
    };
    target.addEventListener("pointermove", (e) => {
      if (this.o.renderer.xr.isPresenting || !this.board.mesh.visible) return;
      const it = hit(e);
      const h = it ? this._rowFromUv(it.uv) : -1;
      if (h !== this.hover) { this.hover = h; this.draw(); }
    });
    target.addEventListener("click", (e) => {
      if (this.o.renderer.xr.isPresenting || !this.board.mesh.visible) return;
      const it = hit(e);
      if (it) { const r = this._rowFromUv(it.uv); if (r >= 0) { this.activate(r); return; } }
      if (this.o.onMiss) this.o.onMiss(this._ray, null);
    });
  }
}

/** B/Y ボタンの押し下がりを拾う小道具 (ページ側の vrInput から呼ぶ)。 */
export function menuPressed(session, state) {
  let now = false;
  for (const src of session.inputSources) {
    const gp = src.gamepad;
    if (gp && gp.buttons[5] && gp.buttons[5].pressed) now = true;
  }
  const fired = now && !state.prev;
  state.prev = now;
  return fired;
}
