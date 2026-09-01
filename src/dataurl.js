/* cron 更新データの取得先 (データ配信VPS移設_設計_20260725.md §d)
 *
 * **VPS を先に試し、失敗したら Pages の committed スナップショットへ落ちる。**
 * data.voyager6.net は固定IPの VPS で日次更新される最新データ。GitHub Actions の
 * 共有CI IP が CelesTrak に弾かれる問題を根治するために立てた。
 *
 * ただし**サイトが VPS に依存してはいけない**。静的な土台は Pages のままという方針なので、
 * VPS が落ちていても・不通でも・まだ配備されていなくても、リポジトリに入っている
 * スナップショットで動き続ける。落ちたことに利用者が気づかないのが正しい。
 *
 * URL で上書きできる (この site の住所系の流儀に合わせる):
 *   ?data=https://例/     取得先を差し替える (staging の検証など)
 *   ?data=0               VPS を使わず Pages のスナップショットだけで動かす
 */

const P = new URLSearchParams(location.search);
const RAW = P.get("data");
const DATA_HOST = (RAW === null ? "https://data.voyager6.net" : RAW).replace(/\/+$/, "");

/* VPS が黙って遅い (パケットが落ちる等) ときに、いつまでも待たない。
   フォールバックが手元にあるのだから、待つ価値は数秒しかない。 */
const TIMEOUT_MS = 4000;

/**
 * @param {string} name       配信側のファイル名 (例 "satellites.json")
 * @param {string} fallback   Pages 側の URL。ページの階層で違う (例 "../satellites.json")
 */
export async function fetchData(name, fallback = name) {
  if (DATA_HOST && DATA_HOST !== "0") {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(`${DATA_HOST}/${name}`, { signal: ac.signal });
      if (r.ok) return await r.json();
    } catch {
      /* 不通・タイムアウト・CORS → フォールバックへ。ここでは何も言わない */
    } finally {
      clearTimeout(timer);
    }
  }
  const r = await fetch(fallback);
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}
