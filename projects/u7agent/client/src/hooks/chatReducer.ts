// chatReducer の入口。アクション群ごとの module へ委譲するだけで、状態遷移を持たない。
import type { ChatAction, ChatState } from "../lib/chatState";
import { applyHistoryAction } from "./chatHistoryReducer";
import { applyRunAction } from "./chatRunReducer";
import { applyQueueAction } from "./chatQueueReducer";
import { applyToolAction } from "./chatToolReducer";
import { applyNoticeAction } from "./chatNoticeReducer";

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "newChat":
    case "resetHistory":
    case "resync":
    case "resyncHistory":
    case "historyGap":
    case "historyGapFailed":
    case "prependHistory":
    case "historyLoading":
    case "historyUnsupported":
      return applyHistoryAction(state, action);

    case "runStart":
    case "runEnd":
    case "setRun":
    case "retry":
    case "usage":
    case "status":
    case "assistantEnd":
    case "text":
    case "thinkingCleared":
      return applyRunAction(state, action);

    case "queued":
    case "queueCleared":
    case "queueCanceled":
    case "localUser":
    case "echoSendId":
    case "resendUnsent":
    case "resendFailed":
    case "unsentDiscarded":
    case "dropLocalUser":
      return applyQueueAction(state, action);

    case "toolStart":
    case "toolEnd":
    case "toolProgress":
    case "compaction":
      return applyToolAction(state, action);

    case "notice":
    case "clearNotice":
    case "setActivity":
    case "startFlashEnd":
      return applyNoticeAction(state, action);
  }
}
