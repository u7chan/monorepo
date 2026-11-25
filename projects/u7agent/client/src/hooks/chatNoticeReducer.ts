// 操作の結果・活動行・開始演出の終わりを受け持つ。
import type { ChatAction, ChatState } from "../lib/chatState";

/** 通知と表示を受け持つアクション (この関数へ委譲する種別だけを抜き出す) */
type NoticeChatAction = Extract<
  ChatAction,
  {
    type: "notice" | "clearNotice" | "setActivity" | "startFlashEnd";
  }
>;

export function applyNoticeAction(state: ChatState, action: NoticeChatAction): ChatState {
  switch (action.type) {
    case "notice":
      // 押した結果は活動文言と別に持つ。後続の status / resync が activity を戻しても、この 1 行は
      // 次の操作かセッション切替まで残る (取り消しの成否が読めないまま消えるのを避ける)
      return { ...state, notice: action.text };

    case "clearNotice":
      // 保持の解除は利用者の操作の **開始** だけ。応答 (setRun / queueCanceled など) で消すと、
      // 先に始めた要求の後着応答が、その後に出た別の操作の結果を消す
      return state.notice === undefined ? state : { ...state, notice: undefined };

    case "setActivity":
      // 実行とは別の知らせ (設定変更 / 接続エラーなど) を活動行へ出す。演出の対象外
      return { ...state, activity: action.text, activityState: undefined };

    case "startFlashEnd":
      // リングの広がりが終わった合図。演出を持たないときに落としても何も変わらない
      return state.startingRunId === undefined ? state : { ...state, startingRunId: undefined };
  }
}
