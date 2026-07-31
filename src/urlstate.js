/* 表示レイヤの ON/OFF を URL に載せる (三部作の 3D ページで共有)。

   なぜ localStorage ではなく URL か:
   このサイトは「見えているものには必ず住所がある」という約束で作ってある。
   localStorage に入れると、同じ URL が人によって違うものを出すことになり、
   URL を渡しても同じ空にならない。URL に載せておけば、
     - 更新しても設定が消えない (VRの新機能を確認するのに毎回入れ直さずに済む)
     - 人にも AI にも「この設定の空」を渡せる
     - ページ間を移るときにそのまま持っていける
   の3つが同時に片づく。

   載せるのはチェックボックス (表示レイヤ) だけ。再生速度や時刻は VR 入場時に
   こちらが勝手に書き換えるので、URL に出すと履歴が濁る。 */

const val = (e) => (e.type === "checkbox" ? (e.checked ? "1" : "0") : e.value);
const set = (e, v) => {
  if (e.type === "checkbox") e.checked = (v === "1" || v === "true");
  else e.value = v;
};

/**
 * @param {Array<{id: string, key?: string}>} spec  key を省くと id の接頭辞を落としたものを使う
 * @returns {{write: function, link: function}}  link(パス) = 今の設定を積んだ移動先 URL
 */
export function bindUrlState(spec) {
  const items = [];
  for (const s of spec) {
    const el = document.getElementById(s.id);
    if (!el) continue;                       // ページによっては無い項目がある
    items.push({ el, key: s.key || s.id.replace(/^[a-z]+-/, ""), def: val(el) });
  }

  // URL → 画面 (既定値と同じなら触らない = 余計な change を投げない)
  const q = new URLSearchParams(location.search);
  for (const it of items) {
    const v = q.get(it.key);
    if (v == null || v === val(it.el)) continue;
    set(it.el, v);
    it.el.dispatchEvent(new Event("change"));
  }

  // 画面 → URL。既定値のものは書かない (URL を短く保つ)
  const params = () => {
    const u = new URLSearchParams(location.search);
    for (const it of items) {
      const v = val(it.el);
      if (v === it.def) u.delete(it.key); else u.set(it.key, v);
    }
    return u;
  };
  const write = () => {
    const u = params();
    history.replaceState(null, "", location.pathname + (u.toString() ? "?" + u : ""));
  };
  for (const it of items) it.el.addEventListener("change", write);
  write();
  return { write };
}
