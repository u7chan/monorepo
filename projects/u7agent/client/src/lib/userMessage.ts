/**
 * user バブルの長文折りたたみ。
 * 実際に切り取る高さは CSS (.user-message-clamp の `max-block-size: 15rem` = 既定フォントで 240px) が持ち、
 * この値は仮想スクロールの見積り (lib/chatItems.ts) にだけ使う。
 */
export const USER_MESSAGE_CLAMP_PX = 240;

export interface UserMessageClamp {
  /** 切り取る高さ (px)。まだあふれていないときは 0 (clamp の高さが未確定) */
  clampHeight: number;
  /** 本文が clamp の高さを超えているか */
  clamped: boolean;
}

/**
 * 計測値から clamp の状態を求める。clientHeight は開閉の遷移中に動くため、あふれた時点で
 * 確定した clamp の高さを基準に固定する (遷移中も「あふれている」判定がぶれず、開閉ボタンが消えない)。
 * scrollHeight は切り取り中でも全文の高さを返す。
 */
export function measureUserMessageClamp({
  scrollHeight,
  clientHeight,
  clampHeight,
}: {
  scrollHeight: number;
  clientHeight: number;
  /** 前回までに確定した clamp の高さ。未確定は 0 */
  clampHeight: number;
}): UserMessageClamp {
  if (clampHeight > 0) {
    return { clampHeight, clamped: scrollHeight > clampHeight + 1 };
  }
  // 未確定のときは、あふれているときの clientHeight が clamp の高さになる
  // (収まっていれば clientHeight == scrollHeight)
  if (scrollHeight > clientHeight + 1) {
    return { clampHeight: clientHeight, clamped: true };
  }
  return { clampHeight: 0, clamped: false };
}
