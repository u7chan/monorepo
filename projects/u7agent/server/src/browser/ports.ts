/**
 * 1 呼び出しが待ち受けるポート。同時実行の枠 (index) から決める。
 *
 * レンジ内を空き探索すると、閉じた検証用ポート (`reserveClosedPort` が bind して閉じたポート) を
 * 直後に fixture が取り直し、`ERR_CONNECTION_REFUSED` を期待する検査が別の結果に化ける。
 * 枠ごとに固定の 3 ポートを割り当てて、探索そのものを無くす。
 *
 * 枠はプロセスをまたいで排他される (concurrency.ts) ため、同じブロックを 2 つの呼び出しが
 * 同時に使うことはない。範囲外へは出さず、埋まっていれば失敗させる (レンジ外のポートを使わない)。
 */
import { BROWSER_PORT_RANGE_END, BROWSER_PORT_RANGE_START, PORTS_PER_CALL } from "./limits";

export interface BrowserPorts {
  /** deny-all proxy の待受 */
  proxy: number;
  /** HTTP / WebSocket の fixture の待受 (両方で 1 ポートを共有する) */
  fixture: number;
  /** 接続が必ず失敗することを確かめるための、閉じたままのポート */
  closed: number;
}

/** 枠の番号から、その呼び出しが使う 3 ポートを決める */
export function browserPortsForSlot(index: number): BrowserPorts {
  if (!Number.isInteger(index) || index < 0) throw new Error(`枠の番号が不正です: ${index}`);
  const base = BROWSER_PORT_RANGE_START + index * PORTS_PER_CALL;
  if (base + PORTS_PER_CALL - 1 > BROWSER_PORT_RANGE_END) {
    throw new Error(
      `ブラウザの待受ポートが範囲 (${BROWSER_PORT_RANGE_START}-${BROWSER_PORT_RANGE_END}) を超えました: 枠 ${index}`,
    );
  }
  return { proxy: base, fixture: base + 1, closed: base + 2 };
}

/** レンジが受け入れられる呼び出しの数。同時実行の上限を収められるかを起動時に確かめる */
export function browserPortRangeCapacity(): number {
  return Math.floor((BROWSER_PORT_RANGE_END - BROWSER_PORT_RANGE_START + 1) / PORTS_PER_CALL);
}
