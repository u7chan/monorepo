// チャットの自動追従 (最下部付近にいるときだけ最新へ付ける) の判定。
// client のテストに DOM 基盤が無いため、DOM を触らない純関数だけをここに置く。
// 配線 (Effect / scroll ハンドラ / ResizeObserver) は ChatArea が持ち、ソース走査で固定する。

/**
 * 最下部からの距離がこれ以内なら追従を続ける (px)。本文の行高は 22.75px (styles/index.css の .md) なので、
 * 丸め誤差や遅延ロードの小さなズレでは外れず、意図的な上スクロールでは外れる 2 行ぶんを取る。
 * ホイール量は機器と設定に依存するため「1 ノッチで必ず外れる」は保証しない。
 */
export const CHAT_FOLLOW_THRESHOLD = 48;

/** 控えた snap の位置と scroll イベントの位置を比べる許容 (px)。代入とイベント配送の丸め誤差だけを吸収する */
export const SNAP_POSITION_EPSILON = 1;

export type ScrollMetrics = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
};

/**
 * 最下部付近にいるか。内容が収まっている (scrollHeight <= clientHeight) ときも true になるため、
 * 追従を続けてよい空の容器・短い履歴で false にはならない。
 */
export function isAtBottom({ scrollTop, scrollHeight, clientHeight }: ScrollMetrics): boolean {
  return scrollHeight - clientHeight - scrollTop <= CHAT_FOLLOW_THRESHOLD;
}

/**
 * snap (自分で書いた最下部への代入) で起きた scroll イベントか。控えが無い / 控えより上へ動いた
 * イベントは false にして通常の距離判定へ回す (代入とイベント配送の間にユーザーが上へ戻した操作を
 * 取りこぼすと、次の更新で引き戻してしまう)。
 */
export function isAutoScrollEvent(scrollTop: number, snapTop: number | null): boolean {
  return snapTop !== null && scrollTop >= snapTop - SNAP_POSITION_EPSILON;
}
