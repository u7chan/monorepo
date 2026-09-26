// チャットの自動追従 (最下部付近にいるときだけ最新へ付ける) の判定。
// client のテストに DOM 基盤が無いため、DOM を触らない純関数だけをここに置く。
// 配線 (Effect / scroll ハンドラ / ResizeObserver) は ChatArea が持ち、ソース走査で固定する。

/**
 * 最下部からの距離がこれ以内なら追従を続ける (px)。本文の行高は 22.75px (styles/index.css の .md) なので、
 * 丸め誤差や遅延ロードの小さなズレでは外れず、意図的な上スクロールでは外れる 2 行ぶんを取る。
 * ホイール量は機器と設定に依存するため「1 ノッチで必ず外れる」は保証しない。
 */
export const CHAT_FOLLOW_THRESHOLD = 48;

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

export type ScrollFollowInput = ScrollMetrics & {
  /** 直前の follow */
  follow: boolean;
  /** 直前に観測した位置 (snap の代入と、前回の scroll イベントの位置) */
  previousTop: number;
};

export type ScrollFollowOutcome = {
  /** 次の follow。false は読み返し中 (追従しない) */
  follow: boolean;
  /** 最下部へ書き戻すか。追従中に最下部から離れているときだけ true */
  snap: boolean;
};

/**
 * scroll イベントを受けたときの次の追従を決める。
 *
 * 追従を外せるのは、ユーザーが上へ戻した (位置が減る) ときだけ。位置が増える scroll は自分の snap の
 * 代入か、レイアウトの再折り返しでブラウザーが動かした位置で、どちらもユーザー操作ではない。右パネルを
 * 開くとチャット幅が変わって本文が折り返し直り、Chrome のスクロールアンカリングが scrollTop を増やして
 * 最下部から離れた位置の scroll を配る。この scroll は同じフレームの ResizeObserver callback より先に
 * 届くため、距離だけで判定すると追従が外れ、直後の callback も follow が false で書き戻さなくなる
 * (実測: 追従中に右パネルを開くと 70/71 で外れた)。
 *
 * 追従中に離れていたら書き戻す。アンカリングを止める (`overflow-anchor: none`) 案は採らない。読み返し中
 * (follow が false) にレイアウトが変わったときの読み位置を保つ役目をブラウザーに残すため。
 */
export function resolveScrollFollow(input: ScrollFollowInput): ScrollFollowOutcome {
  const atBottom = isAtBottom(input);
  if (!input.follow) return { follow: atBottom, snap: false };
  // 上へ戻す操作だけ距離で判定する (snap の代入とイベント配送の間にユーザーが戻した場合もここへ来る)
  if (input.scrollTop < input.previousTop) return { follow: atBottom, snap: false };
  return { follow: true, snap: !atBottom };
}
