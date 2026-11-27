/**
 * チャットの自動追従 (最下部付近にいるときだけ付ける) の判定。DOM を触らない純関数だけを置き、
 * 配線 (Effect / scroll / ResizeObserver) は ChatArea が持つ。
 */

/**
 * 最下部からの距離がこれ以内なら追従を続ける (px)。行高 22.75px の 2 行ぶんを取り、丸め誤差や遅延
 * ロードでは外れず意図的な上スクロールでは外れる (ホイール量は機器依存なので保証しない)。
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
 * scroll イベントを受けたときの次の追従を決める。追従を外せるのは位置が減るときだけで、増える
 * scroll は自分の snap かアンカリング (同じフレームの ResizeObserver より先に届く) なので書き戻す。
 */
export function resolveScrollFollow(input: ScrollFollowInput): ScrollFollowOutcome {
  const atBottom = isAtBottom(input);
  if (!input.follow) return { follow: atBottom, snap: false };
  // 上へ戻す操作だけ距離で判定する (snap の代入とイベント配送の間にユーザーが戻した場合もここへ来る)
  if (input.scrollTop < input.previousTop) return { follow: atBottom, snap: false };
  return { follow: true, snap: !atBottom };
}

/** 上端付近で古いページの先読みを始める距離 (px)。数行の行き来で連続取得しない幅を取る */
export const CHAT_PREPEND_THRESHOLD = 200;

/**
 * 上方向の追加取得を要求するか。取得中の二重要求と、hasMore=false (先頭まで読んだ) を除く。
 * 実際のフェッチは ChatArea のコールバック (useSessions.loadOlderHistory) が担う。
 */
export function shouldLoadOlder({
  scrollTop,
  hasMore,
  loading,
}: {
  scrollTop: number;
  hasMore: boolean;
  loading: boolean;
}): boolean {
  return hasMore && !loading && scrollTop <= CHAT_PREPEND_THRESHOLD;
}
