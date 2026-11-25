// 履歴の同期 (新規チャット / 再同期 / ページの取り込み) を受け持つ。
import {
  canonicalUserText,
  mergeHistoryPage,
  prependHistoryPage,
  rebuildHistoryPage,
  toolCardOf,
} from "../lib/chatHistory";
import type { HistoryMergeResult } from "../lib/chatHistory";
import { ASK_USER_WAITING_TEXT, pendingAskUserQuestionCount } from "../lib/askUser";
import { RESUMED_RUN_ACTIVITY } from "../lib/chatActivity";
import { isToolHostBubble } from "../lib/chatTypes";
import type { Bubble } from "../lib/chatTypes";
import { retryableRunError, runErrorFrom } from "../lib/runRetry";
import { runOutcomeOf } from "../lib/turnEnd";
import type { AssistantMeta, ChatMessage, HistoryPage, PendingSend, RunOutcome, ToolCall } from "../types";
import { initialChatState } from "../lib/chatState";
import type { ChatAction, ChatState } from "../lib/chatState";
import {
  QUEUE_CLEARED,
  UNSENT_CLEARED,
  attachAssistantTurnEnd,
  attachTurnEnd,
  holdsFetchedHistory,
  legacyMarkers,
  mergeRetrySnapshot,
  normalizeInitialSend,
  toolBubbleIdsOf,
} from "./chatReducerShared";
import { attachRunToolCards, carryToolCardsToAnswers, settleToolHosts } from "./chatCards";

function mergeAssistantCard(live: Bubble, history: Bubble): Bubble {
  const liveIds = new Set(live.tools.map((card) => card.id));
  return {
    ...live,
    // 応答IDは履歴 item が持つ値を保つ。本文 item になっていないライブの host を
    // 取り込んだときに、item の対応付けの根拠を落とさないため
    ...(live.assistantId === undefined && history.assistantId !== undefined
      ? { assistantId: history.assistantId }
      : {}),
    // ライブのターンの印 (host) は引き継ぐ。履歴へ対応付いた後も run が終わるまでは live として扱い、
    // run_end / run_start で落とす。ここで外すと、resync のたびにコピーと実行中のカードが履歴へ出る
    host: live.host,
    text: live.text.length >= history.text.length ? live.text : history.text,
    entryId: history.entryId,
    context: history.context ?? live.context,
    at: live.at ?? history.at,
    // 履歴が assistant_end を追い越しても、未確定のライブ応答はモデルを伏せたままにする
    // (確定済み / assistant_end を取りこぼした応答だけ、履歴の値を補完に使う)
    model: live.model !== undefined ? live.model : live.settled === true ? history.model : undefined,
    usage: live.usage ?? history.usage,
    metrics: live.metrics ?? history.metrics,
    turnEnd: history.turnEnd ?? live.turnEnd,
    tools: [...live.tools, ...history.tools.filter((card) => !liveIds.has(card.id))],
    skillLoads: live.skillLoads.length > 0 ? live.skillLoads : history.skillLoads,
  };
}

function turnIndexOf(state: ChatState, liveId: number, bubbles: Bubble[]): number {
  const liveIndex = state.bubbles.findIndex((bubble) => bubble.id === liveId);
  if (liveIndex === -1) return -1;
  const turnUser = state.bubbles
    .slice(0, liveIndex)
    .reverse()
    .find((bubble) => bubble.role === "user");
  if (turnUser?.sendId === undefined) return -1;
  return bubbles.findIndex((bubble) => bubble.role === "user" && bubble.sendId === turnUser.sendId);
}

function stateIndexOfBubble(state: ChatState, bubble: Bubble): number {
  if (bubble.assistantId !== undefined) {
    const index = state.bubbles.findIndex((item) => item.assistantId === bubble.assistantId);
    if (index !== -1) return index;
  }
  if (bubble.sendId !== undefined) {
    const index = state.bubbles.findIndex((item) => item.sendId === bubble.sendId);
    if (index !== -1) return index;
  }
  if (bubble.runId !== undefined) {
    const index = state.bubbles.findIndex((item) => item.role === "user" && item.runId === bubble.runId);
    if (index !== -1) return index;
  }
  for (let index = state.bubbles.length - 1; index >= 0; index -= 1) {
    if (state.bubbles[index].role === bubble.role && state.bubbles[index].text === bubble.text) return index;
  }
  return -1;
}

function runIdentityOf(state: ChatState, bubbles: Bubble[]): { runId?: string; initialSendId?: string } {
  let runId = state.currentRunId;
  if (runId === undefined) {
    for (let index = bubbles.length - 1; index >= 0; index -= 1) {
      const bubble = bubbles[index];
      if (bubble.role === "user" && bubble.runId !== undefined) {
        runId = bubble.runId;
        break;
      }
      if (bubble.role === "assistant" && bubble.assistantId !== undefined) {
        const separator = bubble.assistantId.lastIndexOf(":");
        if (separator > 0) {
          runId = bubble.assistantId.slice(0, separator);
          break;
        }
      }
    }
  }
  if (runId === undefined) return {};
  const firstUser = bubbles.find(
    (bubble) =>
      bubble.role === "user" && bubble.runId === runId && bubble.sendId !== undefined && bubble.unsent !== true,
  );
  return { runId, initialSendId: state.runInitialSendIds[runId] ?? firstUser?.sendId };
}

function orderInitialUser(bubbles: Bubble[], runId: string | undefined, initialSendId: string | undefined): Bubble[] {
  if (runId === undefined) return bubbles;
  const userIndex =
    initialSendId === undefined
      ? bubbles.findIndex((bubble) => bubble.role === "user" && bubble.runId === runId && bubble.unsent !== true)
      : bubbles.findIndex(
          (bubble) => bubble.role === "user" && bubble.sendId === initialSendId && bubble.unsent !== true,
        );
  if (userIndex === -1) return bubbles;
  const prefix = `${runId}:`;
  const assistantIndex = bubbles.findIndex(
    (bubble) => bubble.role === "assistant" && bubble.assistantId?.startsWith(prefix) === true,
  );
  if (assistantIndex === -1 || assistantIndex > userIndex) return bubbles;
  const user = bubbles[userIndex];
  const rest = bubbles.filter((_, index) => index !== userIndex);
  const target = rest.findIndex(
    (bubble) => bubble.role === "assistant" && bubble.assistantId?.startsWith(prefix) === true,
  );
  return target === -1 ? bubbles : [...rest.slice(0, target), user, ...rest.slice(target)];
}

function insertByStatePosition(state: ChatState, rebuilt: Bubble[], liveBubble: Bubble): Bubble[] {
  const liveIndex = state.bubbles.findIndex((bubble) => bubble.id === liveBubble.id);
  if (liveIndex === -1) return [...rebuilt, liveBubble];
  let insertAt = rebuilt.length;
  for (let index = 0; index < rebuilt.length; index += 1) {
    if (stateIndexOfBubble(state, rebuilt[index]) > liveIndex) {
      insertAt = index;
      break;
    }
  }
  return [...rebuilt.slice(0, insertAt), liveBubble, ...rebuilt.slice(insertAt)];
}

/** ページ取得時に実行中だったツールはページに載らず所有者が切れるため、ライブ側から補う */
function restoreSettledTools(
  state: ChatState,
  bubbles: Bubble[],
  liveId: number | null,
  pairs: Map<number, string>,
): Bubble[] {
  let next = bubbles;
  // 使った履歴 item を控えないと、同文の別応答へ同じ item のツールを複製する
  const used = new Set<number>();
  const indexById = new Map<number, number>();
  const indicesByEntryId = new Map<string, number[]>();
  const indicesByAssistantId = new Map<string, number[]>();
  const indicesByText = new Map<string, number[]>();
  const indexByUserSendId = new Map<string, number>();
  bubbles.forEach((bubble, index) => {
    indexById.set(bubble.id, index);
    if (bubble.role === "user" && bubble.sendId !== undefined && !indexByUserSendId.has(bubble.sendId)) {
      indexByUserSendId.set(bubble.sendId, index);
    }
    if (bubble.entryId === undefined) return;
    const entryIndices = indicesByEntryId.get(bubble.entryId) ?? [];
    entryIndices.push(index);
    indicesByEntryId.set(bubble.entryId, entryIndices);
    if (bubble.role !== "assistant") return;
    if (bubble.assistantId !== undefined) {
      const assistantIndices = indicesByAssistantId.get(bubble.assistantId) ?? [];
      assistantIndices.push(index);
      indicesByAssistantId.set(bubble.assistantId, assistantIndices);
    }
    const textIndices = indicesByText.get(bubble.text) ?? [];
    textIndices.push(index);
    indicesByText.set(bubble.text, textIndices);
  });
  // turnIndexOf を live ごとに走査しないための表。各 assistant の直前の user 送信IDを控える
  const turnSendIdByLiveId = new Map<number, string | undefined>();
  let currentTurnSendId: string | undefined;
  for (const bubble of state.bubbles) {
    if (bubble.role === "user") currentTurnSendId = bubble.sendId;
    else turnSendIdByLiveId.set(bubble.id, currentTurnSendId);
  }
  const firstUnused = (indices: number[] | undefined, fromEnd: boolean): number => {
    if (indices === undefined) return -1;
    if (fromEnd) {
      for (let i = indices.length - 1; i >= 0; i -= 1) {
        const index = indices[i];
        if (!used.has(index)) return index;
      }
      return -1;
    }
    for (const index of indices) {
      if (!used.has(index)) return index;
    }
    return -1;
  };
  for (const live of state.bubbles) {
    if (live.role !== "assistant" || live.entryId !== undefined || live.id === liveId) continue;
    if (indexById.has(live.id)) continue;
    const paired = pairs.get(live.id);
    let match = paired === undefined ? -1 : firstUnused(indicesByEntryId.get(paired), false);
    if (match === -1 && live.assistantId !== undefined) {
      match = firstUnused(indicesByAssistantId.get(live.assistantId), false);
    }
    if (match === -1 && live.assistantId === undefined) {
      // 応答IDが片方にしか無い旧データだけ、同一ターン内の本文一致へ縮退する。本文を持たない
      // バブル (ツールだけの host) は空文字の一致だけで別の item へ載せない
      if (live.text === "") continue;
      const turnSendId = turnSendIdByLiveId.get(live.id);
      const turnIndex = turnSendId === undefined ? -1 : (indexByUserSendId.get(turnSendId) ?? -1);
      if (turnIndex === -1) continue;
      const candidates = indicesByText.get(live.text);
      if (candidates !== undefined) {
        for (let i = candidates.length - 1; i >= 0; i -= 1) {
          const index = candidates[i];
          if (index <= turnIndex) break;
          if (used.has(index)) continue;
          match = index;
          break;
        }
      }
    }
    if (match === -1) continue;
    used.add(match);
    next = next.map((bubble, index) => (index === match ? mergeAssistantCard(live, bubble) : bubble));
  }
  return next;
}

/** 保存済み messages にライブの結末は載らないため、履歴ページ適用後も Done を残す */
function restoreUserTurnEnds(state: ChatState, bubbles: Bubble[]): Bubble[] {
  // 写す相手が居ない再同期で索引を作らないため、先に対象の live だけを取り出す
  const ended = state.bubbles.filter(
    (bubble): bubble is Bubble & { runDurationMs: number } =>
      bubble.role === "user" && bubble.runDurationMs !== undefined,
  );
  if (ended.length === 0) return bubbles;
  // sendId は先頭・本文は末尾の一致を使うため、索引にも同じ側の 1 件だけを控える
  const ids = new Set<number>();
  const indexBySendId = new Map<string, number>();
  const indexByText = new Map<string, number>();
  bubbles.forEach((bubble, index) => {
    ids.add(bubble.id);
    if (bubble.role !== "user") return;
    if (bubble.sendId !== undefined && !indexBySendId.has(bubble.sendId)) indexBySendId.set(bubble.sendId, index);
    indexByText.set(bubble.text, index);
  });
  // 一致のたびに map で配列を作り直すと、結末を持つ user の数だけ全バブルを走査し直すことになる
  const updates = new Map<number, { runDurationMs: number; runOutcome: RunOutcome | undefined }>();
  for (const live of ended) {
    if (ids.has(live.id)) continue;
    const match =
      live.sendId === undefined ? (indexByText.get(live.text) ?? -1) : (indexBySendId.get(live.sendId) ?? -1);
    if (match === -1) continue;
    updates.set(match, { runDurationMs: live.runDurationMs, runOutcome: live.runOutcome });
  }
  if (updates.size === 0) return bubbles;
  return bubbles.map((bubble, index) => {
    const update = updates.get(index);
    return update === undefined ? bubble : { ...bubble, ...update };
  });
}

/** 本文一致で寄せると同文の別応答を取り違えるため、応答IDがあるときはそれだけで対応付ける */
function mergeStreamingIntoHistory(
  state: ChatState,
  bubbles: Bubble[],
  pairs: Map<number, string>,
): { bubbles: Bubble[]; currentAssistantId: number | null; toolBubbleIds: Record<string, number> } {
  const liveId = state.currentAssistantId;
  const live = liveId === null ? undefined : state.bubbles.find((bubble) => bubble.id === liveId);
  if (live === undefined || state.runStatus !== "running") {
    const kept = restoreSettledTools(state, bubbles, liveId, pairs);
    return {
      bubbles: kept,
      currentAssistantId: liveId !== null && kept.some((bubble) => bubble.id === liveId) ? liveId : null,
      toolBubbleIds: toolBubbleIdsOf(kept),
    };
  }
  let matchIndex = -1;
  if (live.assistantId !== undefined) {
    // 応答IDがあるときは本文一致・位置推定を使わない (同本文の別応答を取り違えない)
    matchIndex = bubbles.findIndex(
      (bubble) =>
        bubble.role === "assistant" && bubble.entryId !== undefined && bubble.assistantId === live.assistantId,
    );
    if (matchIndex === -1) {
      // 両方に ID があるときに本文で寄せると別応答を取り違えるため、片方だけの旧データに限る
      let turnIndex = turnIndexOf(state, live.id, bubbles);
      if (turnIndex === -1) {
        // 今ターンの user が履歴に無いと本文一致の範囲が決まらないため、最後の user を境界にする
        for (let index = bubbles.length - 1; index >= 0; index -= 1) {
          if (bubbles[index].role === "user") {
            turnIndex = index;
            break;
          }
        }
      }
      if (turnIndex !== -1) {
        const candidates: number[] = [];
        for (let index = bubbles.length - 1; index > turnIndex; index -= 1) {
          const bubble = bubbles[index];
          if (bubble.role !== "assistant" || bubble.entryId === undefined || bubble.assistantId !== undefined) continue;
          if (bubble.text === "" || live.text === "") continue;
          if (bubble.text.startsWith(live.text) || live.text.startsWith(bubble.text)) candidates.push(index);
        }
        if (candidates.length === 1) matchIndex = candidates[0];
      }
    }
  } else {
    // 今ターンの開始 user より前の assistant へは寄せない (前ターンの同一文面を上書きしない)
    const turnIndex = turnIndexOf(state, live.id, bubbles);
    // 保存済みの同じ応答 (ライブの本文の先頭まで) を今ターンの範囲で探す。空の応答は完全一致だけを対象にする
    if (turnIndex !== -1) {
      for (let index = bubbles.length - 1; index > turnIndex; index -= 1) {
        const bubble = bubbles[index];
        if (bubble.role !== "assistant" || bubble.entryId === undefined) continue;
        if (state.closedAssistantTexts.includes(bubble.text)) continue;
        if (bubble.text === live.text || (bubble.text.length > 0 && live.text.startsWith(bubble.text))) {
          matchIndex = index;
          break;
        }
      }
    }
  }
  if (matchIndex === -1) {
    // 照合できない履歴マージでライブのカードが消えていても、今ターンの応答として残す (データを失わない)
    const base = bubbles.some((bubble) => bubble.id === liveId) ? bubbles : [...bubbles, live];
    const kept = restoreSettledTools(state, base, liveId, pairs);
    return { bubbles: kept, currentAssistantId: liveId, toolBubbleIds: toolBubbleIdsOf(kept) };
  }
  const mergedBubble = mergeAssistantCard(live, bubbles[matchIndex]);
  const next = restoreSettledTools(
    state,
    bubbles
      .map((bubble, index) => (index === matchIndex ? mergedBubble : bubble))
      .filter((bubble, index) => index === matchIndex || bubble.id !== liveId),
    liveId,
    pairs,
  );
  return { bubbles: next, currentAssistantId: liveId, toolBubbleIds: toolBubbleIdsOf(next) };
}

/**
 * 完了ツールは本文なし応答から次の表示本文へ繰り上げて投影される。本文を持つ側を正としないと、
 * 再接続で合成したカードと投影先の両方に同じ call が出て、再読み込みと食い違う。
 */
function dedupeToolCards(
  bubbles: Bubble[],
  keepId: number | null,
): { bubbles: Bubble[]; toolBubbleIds: Record<string, number> } {
  const owners = new Map<string, Bubble>();
  for (const bubble of bubbles) {
    for (const card of bubble.tools) {
      const owner = owners.get(card.id);
      if (owner === undefined || (owner.text === "" && bubble.text !== "")) owners.set(card.id, bubble);
    }
  }
  const next: Bubble[] = [];
  for (const bubble of bubbles) {
    // 繰り上げや履歴の突き合わせで同じ応答に同じ call が 2 度載っても、カードは 1 枚にする
    const seen = new Set<string>();
    const tools = bubble.tools.filter((card) => {
      if (owners.get(card.id) !== bubble || seen.has(card.id)) return false;
      seen.add(card.id);
      return true;
    });
    if (tools.length === bubble.tools.length) {
      next.push(bubble);
      continue;
    }
    // ツールを失っただけの空の合成カードは残さない。履歴 item の id はページの連続性の基準なので残す
    const empty =
      bubble.role === "assistant" &&
      bubble.text === "" &&
      bubble.entryId === undefined &&
      bubble.skillLoads.length === 0 &&
      bubble.usage === undefined &&
      bubble.metrics === undefined &&
      bubble.turnEnd === undefined;
    if (empty && tools.length === 0 && bubble.id !== keepId) continue;
    next.push({ ...bubble, tools });
  }
  const toolBubbleIds: Record<string, number> = {};
  for (const bubble of next) {
    for (const card of bubble.tools) {
      if (toolBubbleIds[card.id] === undefined) toolBubbleIds[card.id] = bubble.id;
    }
  }
  return { bubbles: next, toolBubbleIds };
}

/** 履歴ページの適用結果を chat 状態へ写す (保留中の gap は解消済みにする) */
function applyHistoryMerge(state: ChatState, merged: HistoryMergeResult, page: HistoryPage): ChatState {
  const streaming = mergeStreamingIntoHistory(state, merged.bubbles, merged.pairs);
  const identity = runIdentityOf(state, streaming.bubbles);
  const normalized = normalizeInitialSend(streaming.bubbles, identity.initialSendId);
  const ordered = orderInitialUser(normalized, identity.runId, identity.initialSendId);
  const carried = carryToolCardsToAnswers(ordered, streaming.currentAssistantId);
  const deduped = dedupeToolCards(carried.bubbles, streaming.currentAssistantId);
  return {
    ...state,
    bubbles: restoreLiveHost(state, restoreUserTurnEnds(state, deduped.bubbles)),
    nextId: merged.nextId,
    toolBubbleIds: deduped.toolBubbleIds,
    currentAssistantId: streaming.currentAssistantId,
    currentAssistantKey:
      streaming.currentAssistantId === null
        ? undefined
        : ordered.find((bubble) => bubble.id === streaming.currentAssistantId)?.assistantId,
    ...(state.toolTargetAssistantId !== undefined && carried.dropped.has(state.toolTargetAssistantId)
      ? { toolTargetAssistantId: undefined }
      : {}),
    dividers: merged.markers,
    pendingEchoIds: merged.pendingEchoIds,
    sessionId: page.sessionId,
    history: {
      supported: true,
      unsupported: false,
      hasMore: page.hasMore,
      nextCursor: page.nextCursor,
      loading: state.history.loading,
      messageCount: page.messageCount,
      summarizedMessageCount: page.summarizedMessageCount,
      activeContextStartId: page.activeContextStartId,
      gapCursor: null,
      pendingPage: null,
    },
  };
}

/**
 * host の控えが payload の run のものか。どちらかが不明 (旧サーバー / run を持たない payload) な
 * ときは run の変更を判定できないため保持する。判定できるときに違えば、前の run の完了済み host を
 * live に戻さない
 */
function hostLedgerBelongsToRun(ledgerRunId: string | undefined, runId: string | undefined): boolean {
  return ledgerRunId === undefined || runId === undefined || ledgerRunId === runId;
}

/**
 * run が変わったときに、前の run の host を確定する。live の印を外さないと、履歴ページが届くまでの
 * 間だけ古いターンのコピーと実行中の行が隠れたままになる
 */
function settleDroppedHosts(bubbles: Bubble[], assistantIds: readonly string[]): Bubble[] {
  if (assistantIds.length === 0) return bubbles;
  const dropped = new Set(assistantIds);
  let changed = false;
  const next = bubbles.map((bubble) => {
    if (!isToolHostBubble(bubble) || bubble.assistantId === undefined || !dropped.has(bubble.assistantId)) {
      return bubble;
    }
    changed = true;
    return { ...bubble, host: undefined, settled: true };
  });
  return changed ? next : bubbles;
}

/**
 * ページ再構築の後に、本文 item を引き取った host の印を戻す。mergeHistoryPage は履歴 item から
 * バブルを組み直し、host は履歴に載らないため、対応付けが済んだ host は live の照合対象から外れて
 * 印を失う。run の終端 (run_end / run_start) までは同じ応答を host として扱い、実行中の行とコピーを
 * 再構築の後に出さない。応答が履歴から消えていれば何もしない。
 */
function restoreLiveHost(state: ChatState, bubbles: Bubble[]): Bubble[] {
  if (state.liveHostAssistantIds.length === 0) return bubbles;
  const hosts = new Set(state.liveHostAssistantIds);
  let changed = false;
  const next = bubbles.map((bubble) => {
    if (bubble.role !== "assistant" || bubble.assistantId === undefined) return bubble;
    if (!hosts.has(bubble.assistantId) || isToolHostBubble(bubble)) return bubble;
    changed = true;
    return { ...bubble, host: true as const };
  });
  return changed ? next : bubbles;
}

/**
 * 履歴 API の最新ページが届くまでの初期表示に使う payload.messages の上限。全量を組むと長い会話で
 * バブル数と merge が履歴長に比例して増え、最初のページ適用が固まるため、直近だけを即時表示する。
 * 古い側はスクロール時のページ取得に委ね、履歴 API が無いときだけ全量で組み直す。
 */
export const LEGACY_INITIAL_MAX_MESSAGES = 200;

/** 履歴の導出値を写し忘れると resync でツール履歴やバッジが黙って消える */
export function historyToBubbles(
  nextId: number,
  messages: ChatMessage[],
): { bubbles: Bubble[]; nextId: number; toolBubbleIds: Record<string, number> } {
  const toolBubbleIds: Record<string, number> = {};
  const seenToolCallIds = new Set<string>();
  const bubbles: Bubble[] = messages.map((message) => {
    const id = nextId++;
    const tools = (message.tools ?? [])
      .filter((call) => {
        if (seenToolCallIds.has(call.id)) return false;
        seenToolCallIds.add(call.id);
        return true;
      })
      .map(toolCardOf);
    for (const card of tools) toolBubbleIds[card.id] = id;
    return {
      id,
      legacy: true,
      role: message.role,
      text: message.text,
      ...(message.model !== undefined ? { model: message.model } : {}),
      ...(message.assistantId !== undefined ? { assistantId: message.assistantId } : {}),
      ...(message.sendId !== undefined ? { sendId: message.sendId } : {}),
      ...(message.runId !== undefined ? { runId: message.runId } : {}),
      tools,
      skillLoads: message.skillLoads ?? [],
      at: message.at,
      usage: message.usage,
      metrics: message.metrics,
    };
  });
  return { bubbles, nextId, toolBubbleIds };
}

/** 送信IDが結び付く前に届いた待機位置を、より新しい状態が無い分だけ残す */
function pruneQueuedSnapshots(
  snapshots: ChatState["queuedSnapshots"],
  pendingSends: PendingSend[] | undefined,
): ChatState["queuedSnapshots"] {
  if (pendingSends === undefined) return snapshots;
  const waiting = new Map(
    pendingSends
      .filter((send) => send.state === "queued" || send.state === "steering")
      .map((send) => [send.sendId, send] as const),
  );
  let next: ChatState["queuedSnapshots"] = snapshots;
  for (const [sendId, snapshot] of Object.entries(snapshots)) {
    const send = waiting.get(sendId);
    if (send === undefined) {
      if (next === snapshots) next = { ...snapshots };
      delete next[sendId];
      continue;
    }
    const position = send.position ?? snapshot.position;
    if (position !== snapshot.position) {
      if (next === snapshots) next = { ...snapshots };
      next[sendId] = { position };
    }
  }
  return next;
}

/** payload.messages が既に含む応答へ、ライブのテキストを二重に積まない */
function trimStreamedMessages(bubbles: Bubble[], streaming: Bubble | undefined): Bubble[] {
  if (streaming === undefined) return bubbles;
  const last = bubbles[bubbles.length - 1];
  if (last?.role !== "assistant") return bubbles;
  // 投影の本文はストリーミングの累積と一致する (マスク済み)。一致しなければ投影を正とする
  if (last.text !== streaming.text && !streaming.text.startsWith(last.text)) return bubbles;
  return bubbles.slice(0, -1);
}

function sendStateOf(send: PendingSend): Pick<Bubble, "queued" | "queuedState" | "queuePosition" | "runId"> {
  if (send.state === "queued" || send.state === "steering") {
    return {
      queued: true,
      queuedState: send.state,
      ...(send.position === undefined ? {} : { queuePosition: send.position }),
      ...(send.runId === undefined ? {} : { runId: send.runId }),
    };
  }
  // running / unsent は待機一覧の対象外。実行へ割り当て済みなら run id を写す
  return {
    queued: undefined,
    queuedState: undefined,
    queuePosition: undefined,
    ...(send.runId === undefined ? {} : { runId: send.runId }),
  };
}

/**
 * payload.pendingSends (202 で受理したがまだ entry になっていない送信) をバブル列へ写す。
 * `unsent` は pending を外して「未送信」へ切り替え、`queued` / `running` は受理済みの pending として
 * 保つ (別タブの再送中に表示から消さない)。手元にバブルが無い分は末尾へ足す (履歴の初回応答前でも
 * 失わない)。一覧から消えた未送信バブルは、別タブの再送 / 破棄で記録が消えたものとして落とす。
 * `undefined` (旧サーバー) は現状維持。payload に載った送信は停止の控え (`clearedSendIds`) から外す。
 * 待機の表示は payload が正で、一覧から消えた run の待機も解除する (entry が保存された / 実行が始まった)。
 */
function applyPendingSends(
  bubbles: Bubble[],
  pendingEchoIds: number[],
  nextId: number,
  clearedSendIds: string[],
  pendingSends: PendingSend[] | undefined,
): { bubbles: Bubble[]; pendingEchoIds: number[]; nextId: number; clearedSendIds: string[] } {
  if (pendingSends === undefined) return { bubbles, pendingEchoIds, nextId, clearedSendIds };
  const bySendId = new Map(pendingSends.map((send) => [send.sendId, send]));
  const pending = new Set(pendingEchoIds);
  const seen = new Set<string>();
  const next: Bubble[] = [];
  let cursor = nextId;
  for (const bubble of bubbles) {
    // 送信IDを持たないバブル (旧サーバー) は run id でも突き合わせる
    const send =
      bubble.sendId !== undefined
        ? bySendId.get(bubble.sendId)
        : pendingSends.find((candidate) => candidate.runId !== undefined && candidate.runId === bubble.runId);
    const key = send?.sendId ?? bubble.sendId;
    if (send === undefined) {
      if (bubble.sendId === undefined && bubble.runId === undefined) {
        next.push(bubble);
        continue;
      }
      // 一覧に無い = 保存済みか破棄済み。未送信のバブルはここで落とす (保存済みは entry が担う)
      if (bubble.unsent === true) continue;
      next.push({ ...bubble, ...QUEUE_CLEARED });
      continue;
    }
    if (key !== undefined) seen.add(key);
    if (send.state === "unsent") {
      pending.delete(bubble.id);
      next.push({
        ...bubble,
        ...(bubble.sendId === undefined && key !== undefined ? { sendId: key } : {}),
        ...UNSENT_CLEARED,
      });
      continue;
    }
    // 実行中 / 待機中。未送信の表示を戻し、entry が載ったときの吸収に載せる
    if (bubble.entryId === undefined) pending.add(bubble.id);
    next.push({
      ...bubble,
      unsent: false,
      accepted: true,
      confirmed: true,
      ...(bubble.sendId === undefined && key !== undefined ? { sendId: key } : {}),
      ...sendStateOf(send),
    });
  }
  for (const send of pendingSends) {
    if (seen.has(send.sendId)) continue;
    // エコーは送信応答より先に描画される。payload が先に pending 送信を配ったときに同じ本文を
    // もう 1 件足すと、応答が届くまで 1 フレームだけ同じ発言が 2 件並び、追従中のスクロールが跳ねる。
    // 送信IDを持たないエコーが同じ本文なら、そのエコーへ送信IDを結び付ける (pending から外れた
    // 旧経路のエコーも、まだ履歴 item になっていなければ同じ発言なので対象にする)
    const adopted = next.findIndex(
      (bubble) =>
        bubble.entryId === undefined &&
        bubble.role === "user" &&
        bubble.sendId === undefined &&
        bubble.unsent !== true &&
        canonicalUserText(bubble.text) === canonicalUserText(send.text),
    );
    if (adopted !== -1) {
      const bubble = next[adopted];
      if (send.state === "unsent") pending.delete(bubble.id);
      else pending.add(bubble.id);
      next[adopted] = {
        ...bubble,
        sendId: send.sendId,
        ...(send.runId === undefined ? {} : { runId: send.runId }),
        ...(send.state === "unsent"
          ? { ...UNSENT_CLEARED }
          : { unsent: false, accepted: true, confirmed: true, ...sendStateOf(send) }),
      };
      continue;
    }
    const id = cursor++;
    if (send.state === "unsent") {
      next.push({
        id,
        role: "user",
        text: send.text,
        tools: [],
        skillLoads: [],
        at: send.at,
        sendId: send.sendId,
        ...(send.runId === undefined ? {} : { runId: send.runId }),
        unsent: true,
      });
      continue;
    }
    // 受理済み (待機中 / 実行中) もバブルを持たせる。履歴の初回応答前でも消さない
    pending.add(id);
    next.push({
      id,
      role: "user",
      text: send.text,
      tools: [],
      skillLoads: [],
      at: send.at,
      sendId: send.sendId,
      accepted: true,
      ...sendStateOf(send),
    });
  }
  return {
    bubbles: next,
    // pending から外した分を落とし、待機 / 実行中で新たに載せた分を末尾へ足す
    pendingEchoIds: [...pending],
    nextId: cursor,
    // payload が載せた送信は権威ある状態なので、停止の控えは不要
    clearedSendIds: clearedSendIds.filter((id) => !bySendId.has(id)),
  };
}

/** 履歴の同期を受け持つアクション (この関数へ委譲する種別だけを抜き出す) */
type HistoryChatAction = Extract<
  ChatAction,
  {
    type:
      | "newChat"
      | "resetHistory"
      | "resync"
      | "resyncHistory"
      | "historyGap"
      | "historyGapFailed"
      | "prependHistory"
      | "historyLoading"
      | "historyUnsupported";
  }
>;

/**
 * 履歴の同期 (新規チャット / 再同期 / ページの取り込み) を受け持つ。payload からの組み直しが大きく、
 * 送信キューやツールカードとは独立して読めるため `chatReducer` から切り出した。意味と順序は変えない。
 */
export function applyHistoryAction(state: ChatState, action: HistoryChatAction): ChatState {
  switch (action.type) {
    case "newChat": {
      // 未作成チャットは sessionModel 等の実効値を持たず、表示は composerSettings が担う。
      // nextId だけは引き継ぐ (セッションを跨いで古いイベントの bubble id と衝突させない)。
      // runEndSeq も引き継ぐ (右パネルの合図をセッションを跨いで単調に保つ)。
      return {
        ...initialChatState,
        nextId: state.nextId,
        runEndSeq: state.runEndSeq,
        // sendSeq も単調に保つ (新規チャットへの切替を「送信」と誤読させない)
        sendSeq: state.sendSeq,
      };
    }

    case "resetHistory":
      // 会話 id は保ち、表示と履歴だけを捨てる (引き継ぎ後の payload が新しい世代を埋める)。
      // runEndSeq / sendSeq は単調に保ち、bubble id も再利用しない
      return {
        ...state,
        bubbles: [],
        dividers: [],
        toolBubbleIds: {},
        runTools: {},
        pendingEchoIds: [],
        clearedSendIds: [],
        queuedSnapshots: {},
        currentRunId: undefined,
        closedAssistantTexts: [],
        toolTargetAssistantId: undefined,
        liveToolIds: [],
        currentAssistantId: null,
        currentAssistantKey: undefined,
        // 履歴ごと入れ替わるので、前の履歴の host を復元しない
        liveHostAssistantIds: [],
        liveHostRunId: undefined,
        history: initialChatState.history,
        activity: "",
        activityState: undefined,
        thinkingText: undefined,
        // 履歴ごと入れ替わるので、前の履歴の操作の結果は持ち越さない
        notice: undefined,
        handoff: undefined,
        compactions: [],
        context: undefined,
      };

    case "resync": {
      const payload = action.payload;
      const status = payload.status || "idle";
      const sessionChanged = payload.sessionId !== state.sessionId;
      // 未作成チャットへ最初のセッションが届くのは切替ではない (ストリーミング中の応答を捨てない)
      const switchedSession = state.sessionId !== "" && sessionChanged;
      // 全履歴 API が使える間は payload.messages (有効コンテキスト) ではなく履歴ページを表示の正とする。
      // 取得済みの古いページを消さないため、ここでは表示を組み直さない (最新ページは resyncHistory が届く)。
      // ページ取得に一時的に失敗しても、取り込み済みの履歴がある間は payload.messages で組み直さない
      // (messages は有効コンテキストの投影で、圧縮後の残りが tool 呼び出しだけなら空にもなる)
      const keepHistory = !sessionChanged && (state.history.supported || holdsFetchedHistory(state));
      // 未確定の assistant を捨てるのは失敗試行の取り消し (context_edit) だけ。同じ run の継続
      // (追加入力の注入・保存確定など) で捨てると、続く delta が別カードになり live と履歴が食い違う
      const currentLive =
        state.currentAssistantId === null
          ? undefined
          : state.bubbles.find((bubble) => bubble.id === state.currentAssistantId);
      const payloadRunPrefix = payload.run?.id === undefined ? undefined : `${payload.run.id}:`;
      const currentForPayloadRun =
        currentLive !== undefined &&
        (state.currentRunId !== undefined
          ? state.currentRunId === payload.run?.id
          : payloadRunPrefix !== undefined && currentLive.assistantId?.startsWith(payloadRunPrefix) === true);
      const resumingRun =
        !switchedSession &&
        payload.resyncReason === undefined &&
        status === "running" &&
        payload.run?.id !== undefined &&
        currentForPayloadRun;
      const streaming = resumingRun ? currentLive : undefined;
      // run_end を取りこぼすと未保存の現在応答が消えるため、終端 payload でも残す
      const terminalLive =
        !switchedSession &&
        payload.resyncReason === undefined &&
        status !== "running" &&
        payload.run !== null &&
        payload.run !== undefined &&
        currentForPayloadRun &&
        currentLive?.role === "assistant"
          ? currentLive
          : undefined;
      const legacyMessages = payload.messages ?? [];
      const legacy = keepHistory
        ? null
        : historyToBubbles(
            state.nextId,
            state.history.unsupported ? legacyMessages : legacyMessages.slice(-LEGACY_INITIAL_MAX_MESSAGES),
          );
      // 初期 legacy を組み直すときは、旧 legacy をライブとして持ち越さない (全量復元で重複させる)
      const live = state.bubbles.filter(
        (bubble) => bubble.entryId === undefined && (legacy === null || bubble.legacy !== true),
      );
      // 失敗試行は payload.messages の投影から外れている。残す応答をテキストで判断できない
      // ときは取り消しを優先する (投影に無い閉じたカードを残さない)
      const projectedAssistants = (payload.messages ?? [])
        .filter((message) => message.role === "assistant")
        .map((message) => message.text);
      let failedAttempt: Bubble | undefined;
      if (payload.resyncReason === "attempt_discarded") {
        for (let index = live.length - 1; index >= 0; index -= 1) {
          const bubble = live[index];
          if (bubble.role !== "assistant") continue;
          if (
            projectedAssistants.some(
              (text) => text === bubble.text || (bubble.text !== "" && text.startsWith(bubble.text)),
            )
          ) {
            continue;
          }
          failedAttempt = bubble;
          break;
        }
      }
      // 確定済みのライブバブル (前の run の応答 / 送信エコー) は、履歴ページが届くまで残す
      const keptLive = live
        .filter(
          (bubble) =>
            bubble.id !== failedAttempt?.id &&
            (bubble.role === "user" ||
              bubble.settled === true ||
              bubble.id === streaming?.id ||
              bubble.id === terminalLive?.id),
        )
        .map((bubble) => (bubble.id === terminalLive?.id ? { ...bubble, settled: true } : bubble));
      // payload.messages の assistant は保存済み = 閉じた応答。開いている扱いにすると次の delta が連結される
      let rebuilt: Bubble[] = [];
      let streamingMerged = false;
      if (legacy !== null) {
        rebuilt = legacy.bubbles.map((bubble) => (bubble.role === "assistant" ? { ...bubble, settled: true } : bubble));
        // 履歴を持たない会話でも、確定済みの応答と実行中のツールカードを再構成で落とさない
        if (!switchedSession) {
          // 状態順のまま append すると user が応答の後ろへ出るため、payload の順を基準にする
          for (const liveBubble of keptLive) {
            if (liveBubble.role !== "user") continue;
            let userMatch = -1;
            if (liveBubble.sendId !== undefined) {
              userMatch = rebuilt.findIndex((bubble) => bubble.role === "user" && bubble.sendId === liveBubble.sendId);
            } else {
              let lastUser = -1;
              for (let index = rebuilt.length - 1; index >= 0; index -= 1) {
                if (rebuilt[index].role === "user") {
                  lastUser = index;
                  break;
                }
              }
              if (lastUser !== -1 && canonicalUserText(rebuilt[lastUser].text) === canonicalUserText(liveBubble.text)) {
                const liveIndex = state.bubbles.findIndex((bubble) => bubble.id === liveBubble.id);
                const liveNext = state.bubbles.slice(liveIndex + 1).find((bubble) => bubble.role === "assistant");
                const baseNext = rebuilt.slice(lastUser + 1).find((bubble) => bubble.role === "assistant");
                // 本文だけで寄せると前ターンの同名 user へ結末が移るため、直後の応答も一致させる
                const sameNext =
                  baseNext === undefined ||
                  (liveNext !== undefined &&
                    (liveNext.assistantId !== undefined && baseNext.assistantId !== undefined
                      ? liveNext.assistantId === baseNext.assistantId
                      : liveNext.text === baseNext.text));
                if (sameNext) userMatch = lastUser;
              }
            }
            if (userMatch === -1) {
              const initialForRun =
                payload.run?.id !== undefined &&
                payload.run.initialSendId !== undefined &&
                liveBubble.sendId === payload.run.initialSendId;
              const earlyAssistant = initialForRun
                ? rebuilt.findIndex(
                    (bubble) =>
                      bubble.role === "assistant" && bubble.assistantId?.startsWith(`${payload.run?.id}:`) === true,
                  )
                : -1;
              if (earlyAssistant === -1) {
                // 末尾へ append すると前ターンの応答より後ろに並ぶため、状態上の位置へ戻す
                rebuilt = insertByStatePosition(state, rebuilt, liveBubble);
              } else {
                rebuilt = [...rebuilt.slice(0, earlyAssistant), liveBubble, ...rebuilt.slice(earlyAssistant)];
              }
            } else {
              rebuilt = rebuilt.map((bubble, index) =>
                index === userMatch
                  ? {
                      ...bubble,
                      ...liveBubble,
                      text: bubble.text || liveBubble.text,
                      entryId: bubble.entryId,
                      ...(bubble.sendId !== undefined
                        ? { sendId: bubble.sendId }
                        : liveBubble.sendId === undefined
                          ? {}
                          : { sendId: liveBubble.sendId }),
                      ...(bubble.runId !== undefined
                        ? { runId: bubble.runId }
                        : liveBubble.runId === undefined
                          ? {}
                          : { runId: liveBubble.runId }),
                      ...(liveBubble.runDurationMs === undefined ? {} : { runDurationMs: liveBubble.runDurationMs }),
                      ...(liveBubble.runOutcome === undefined ? {} : { runOutcome: liveBubble.runOutcome }),
                    }
                  : bubble,
              );
            }
          }
          for (const liveBubble of keptLive) {
            if (liveBubble.role !== "assistant") continue;
            if (liveBubble.id === streaming?.id && liveBubble.assistantId === undefined) continue;
            let match = -1;
            if (liveBubble.assistantId !== undefined) {
              match = rebuilt.findIndex(
                (bubble) => bubble.role === "assistant" && bubble.assistantId === liveBubble.assistantId,
              );
              if (match === -1) {
                // 両方に ID があるときに本文で寄せると別応答を取り違えるため、片方だけの旧データに限る
                const turnIndex = turnIndexOf(state, liveBubble.id, rebuilt);
                if (turnIndex !== -1) {
                  const candidates: number[] = [];
                  for (let index = rebuilt.length - 1; index > turnIndex; index -= 1) {
                    const bubble = rebuilt[index];
                    if (bubble.role !== "assistant" || bubble.assistantId !== undefined) continue;
                    if (bubble.text === "" || liveBubble.text === "") continue;
                    if (bubble.text.startsWith(liveBubble.text) || liveBubble.text.startsWith(bubble.text)) {
                      candidates.push(index);
                    }
                  }
                  if (candidates.length === 1) match = candidates[0];
                }
              }
            } else {
              const turnIndex = turnIndexOf(state, liveBubble.id, rebuilt);
              const start = turnIndex === -1 ? 0 : turnIndex + 1;
              for (let index = rebuilt.length - 1; index >= start; index -= 1) {
                const bubble = rebuilt[index];
                if (
                  bubble.role === "assistant" &&
                  bubble.assistantId === undefined &&
                  bubble.text === liveBubble.text
                ) {
                  match = index;
                  break;
                }
              }
            }
            if (match === -1) {
              // 末尾へ append すると Done が次のターンへ移るため、状態上の位置へ戻す
              rebuilt = insertByStatePosition(state, rebuilt, liveBubble);
            } else {
              rebuilt = rebuilt.map((bubble, index) =>
                index === match ? mergeAssistantCard(liveBubble, bubble) : bubble,
              );
            }
            if (liveBubble.id === streaming?.id) streamingMerged = true;
          }
        }
      }
      const rebuiltWithStreaming =
        streaming === undefined || streaming.assistantId !== undefined
          ? rebuilt
          : trimStreamedMessages(rebuilt, streaming);
      const assembled = keepHistory
        ? [...state.bubbles.filter((bubble) => bubble.entryId !== undefined), ...keptLive]
        : [...rebuiltWithStreaming, ...(streaming === undefined || streamingMerged ? [] : [streaming])];
      const carried = carryToolCardsToAnswers(assembled, streaming?.id ?? null);
      const deduped = dedupeToolCards(carried.bubbles, streaming?.id ?? null);
      const bubbles = deduped.bubbles;
      const nextId = keepHistory ? state.nextId : (legacy?.nextId ?? state.nextId);
      const toolBubbleIds = deduped.toolBubbleIds;
      const retainedEchoIds = new Set(
        keepHistory ? keptLive.filter((bubble) => bubble.role === "user").map((bubble) => bubble.id) : [],
      );
      // 履歴で置き換えたので、旧バブルを指すエコーの待ち行列は持ち越さない
      const retryState = mergeRetrySnapshot(
        state,
        payload.run?.retry,
        payload.serverNow,
        action.receivedAt ?? Date.now(),
      );
      // 失敗の分類コードは payload から復元する (run_end だけに依存しない)。status が error 以外なら載せない
      const runError = runErrorFrom(status, payload.run?.errorCode, payload.run?.error);
      // 直近 run のツール状態は payload が正。run の無い resync で前の run のカードを残さず、
      // SSE のリプレイ / 再接続の取りこぼしもここで復元する (sessionChanged でも必ず置き換わる)
      const runTools: Record<string, ToolCall> = {};
      for (const call of payload.run?.toolCalls ?? []) runTools[call.id] = call;
      // 本文なしの未回答 ask_user は履歴 item にならないため、応答単位のメタ情報を控えておく
      const assistantMeta: Record<string, AssistantMeta> = {};
      for (const meta of payload.assistantMeta ?? []) assistantMeta[meta.assistantId] = meta;
      // run が終わった合図。run_end を受け取れない復帰 (切断した SSE の resync) でも、running から
      // 抜けていれば進める (パネルの取り直しは run_end とこの 1 回で足りる)
      const runEnded = state.runStatus === "running" && status !== "running";
      let next: ChatState = {
        ...state,
        runEndSeq: state.runEndSeq + (runEnded ? 1 : 0),
        bubbles,
        nextId,
        // 残したローカルエコー以外の待ちは持ち越さない
        pendingEchoIds: state.pendingEchoIds.filter((id) => retainedEchoIds.has(id)),
        currentAssistantId: streaming?.id ?? null,
        currentAssistantKey: streaming?.assistantId,
        currentRunId: status === "running" ? payload.run?.id : undefined,
        toolBubbleIds,
        runTools,
        assistantMeta,
        // 履歴モードでは区切りを履歴ページが正とし、旧 payload では messages の index から復元する
        dividers: keepHistory ? state.dividers : legacyMarkers(payload.compactions ?? []),
        history: sessionChanged ? initialChatState.history : state.history,
        // 別の会話の停止で破棄された送信IDを持ち越さない
        clearedSendIds: sessionChanged ? [] : state.clearedSendIds,
        // 開始直後の演出は live 専用。payload が同じ run の実行中を示すときだけ残す
        startingRunId:
          status === "running" && payload.run?.id === state.startingRunId ? state.startingRunId : undefined,
        // ライブで観測したツール id も持ち越さない (古い id を新しい会話のライブ観測と誤読させない)
        liveToolIds: sessionChanged ? [] : state.liveToolIds,
        sessionId: payload.sessionId,
        title: payload.title,
        titleSummary: payload.titleSummary,
        runStatus: status,
        runStartedAt: status === "running" ? payload.run?.startedAt : undefined,
        // 圧縮の起点は payload の値だけ。終端 resync で status が抜ければ解除される
        compactionStartedAt: status === "compacting" ? payload.compactionStartedAt : undefined,
        queueDepth: payload.queueDepth || 0,
        activity: "",
        // 押した結果は会話を切り替えたときだけ捨てる (同じ会話の取り直しでは残す)
        notice: switchedSession ? undefined : state.notice,
        // 活動の由来は status イベントだけが入れる (復帰時の文言は状態ではなくお知らせなので持たない)
        activityState: undefined,
        // thinking の末尾は live 専用で payload に載らない。同じ run の resync (設定変更 / 圧縮 /
        // context_edit) でも次に届く status で戻る
        thinkingText: undefined,
        sessionModel: payload.model,
        sessionThinkingLevel: payload.thinkingLevel,
        sessionAgentId: payload.agent?.id,
        sessionAgentName: payload.agent?.name,
        // 引き継ぎの状態も payload だけを正とする (旧サーバーは載せない = undefined)
        handoff: payload.handoff,
        // egress の承認状態も payload だけを正とする (旧サーバーは載せない = undefined)
        networkAccess: payload.networkAccess,
        supportsThinking: payload.supportsThinking ?? false,
        availableThinkingLevels: payload.availableThinkingLevels ?? [],
        context: payload.context,
        compactions: payload.compactions ?? [],
        pendingUsage: undefined,
        pendingMetrics: undefined,
        ...retryState,
        runError,
        // ランが終わっていても結果表示用に累計を引き継ぐ (run が無い復元では前の値のまま)
        retryCount: payload.run ? payload.run.totalRetryCount : state.retryCount,
      };
      // 未投影の run 側カードを現在ターンの assistant へ補う (補完先が無ければ保留)。
      // currentAssistantId は実行中のときだけ補完先へ向ける
      next = attachRunToolCards(next, status === "running");
      if (status === "running") {
        // 復帰の文言は長い 1 文 (「実行中…（タブを閉じても処理は続きます）」) なので由来を持たせない
        // (折り返すと帯が行ごとに切れる)。run 自身の短いラベルを配る次の status で再開する。
        // 回答待ちの判定に status を使わないのは、resync ではリプレイされないため
        next = {
          ...next,
          activity: pendingAskUserQuestionCount(runTools, status) > 0 ? ASK_USER_WAITING_TEXT : RESUMED_RUN_ACTIVITY,
        };
      } else if (status === "compacting") next = { ...next, activity: "会話を整理中…" };
      else if (status === "queued") next = { ...next, activity: "" };
      else if (status === "error")
        next = {
          ...next,
          // カードを出すとき (分類コードと status の両方が揃うとき) は文言をカードへ移し、
          // 状態行に同じ 1 文を二重に出さない。分類コードが無い縮退では現行どおり出す
          activity: retryableRunError(status, runError)
            ? ""
            : payload.run?.error
              ? `エラー: ${payload.run.error}`
              : "前回の実行でエラーが発生しました",
        };
      else if (status === "stopped") next = { ...next, activity: "前回の実行は停止されました" };
      const applied = applyPendingSends(
        next.bubbles,
        next.pendingEchoIds,
        next.nextId,
        next.clearedSendIds,
        payload.pendingSends,
      );
      const runOutcome = runOutcomeOf(status);
      const normalizedBubbles = normalizeInitialSend(applied.bubbles, payload.run?.initialSendId);
      let settledBubbles = orderInitialUser(normalizedBubbles, payload.run?.id, payload.run?.initialSendId);
      if (runOutcome !== undefined && payload.run?.endedAt !== undefined) {
        // ライブの run_end を観測済みならその値が正 (payload は run の所要時間を持たない)
        const initialUser = settledBubbles.find(
          (bubble) =>
            bubble.role === "user" &&
            (payload.run?.initialSendId === undefined
              ? bubble.runId === payload.run?.id
              : bubble.sendId === payload.run?.initialSendId),
        );
        const durationMs = initialUser?.runDurationMs ?? Math.max(0, payload.run.endedAt - payload.run.startedAt);
        const outcome = initialUser?.runOutcome ?? runOutcome;
        if (initialUser !== undefined && initialUser.runDurationMs === undefined) {
          settledBubbles = attachTurnEnd(
            settledBubbles,
            payload.run.id,
            payload.run.initialSendId,
            outcome,
            durationMs,
          );
        }
        // user の位置に依存すると Done が消えるため、run の最後の本文あり assistant へ直接付ける
        settledBubbles = attachAssistantTurnEnd(
          settledBubbles,
          payload.run.id,
          payload.run.initialSendId,
          outcome,
          durationMs,
          state.currentAssistantId,
        );
      }
      // host の控えは同じ run の再同期だけで使う。切断中に前の run が終わり次の run が始まると
      // `run_start` のリプレイなしで `resync` だけが届くため、run が変わっていたら前ターンの
      // 完了済み host を live に戻さない (コピーと実行中の行を隠したままにしない)
      const retainedHostIds =
        status === "running" && !switchedSession && hostLedgerBelongsToRun(state.liveHostRunId, payload.run?.id)
          ? state.liveHostAssistantIds
          : [];
      const droppedHostIds = state.liveHostAssistantIds.filter((id) => !retainedHostIds.includes(id));
      const hostSettled = settleDroppedHosts(settledBubbles, droppedHostIds);
      // run が終わっているターンの host は、確定履歴の item 境界 (本文なし応答ごと) へ揃えておく。
      // 実行中は本文 item が現れるかもしれないので、溜めたままにする
      const finalized =
        status === "running"
          ? { bubbles: hostSettled, nextId: applied.nextId, toolBubbleIds: next.toolBubbleIds }
          : settleToolHosts({ ...next, bubbles: hostSettled, nextId: applied.nextId });
      return {
        ...next,
        bubbles: finalized.bubbles,
        pendingEchoIds: applied.pendingEchoIds,
        nextId: finalized.nextId,
        toolBubbleIds: finalized.toolBubbleIds,
        clearedSendIds: applied.clearedSendIds,
        stateSeq: state.stateSeq + 1,
        closedAssistantTexts: switchedSession ? [] : state.closedAssistantTexts,
        // 実行中でなければ host は確定済み (settleToolHosts) なので、次のページ再構築で戻さない
        liveHostAssistantIds: retainedHostIds,
        liveHostRunId: retainedHostIds.length === 0 ? undefined : state.liveHostRunId,
        toolTargetAssistantId:
          !switchedSession &&
          state.toolTargetAssistantId !== undefined &&
          applied.bubbles.some((bubble) => bubble.id === state.toolTargetAssistantId)
            ? state.toolTargetAssistantId
            : undefined,
        // 別の会話の送信へ引き継がない
        queuedSnapshots: sessionChanged ? {} : pruneQueuedSnapshots(state.queuedSnapshots, payload.pendingSends),
      };
    }

    case "resyncHistory": {
      const page = action.page;
      const live = state.bubbles.filter((bubble) => bubble.entryId === undefined);
      const bundle = mergeHistoryPage(
        { bubbles: state.bubbles, markers: state.dividers, nextId: state.nextId, toolBubbleIds: state.toolBubbleIds },
        page,
        { live, pendingEchoIds: state.pendingEchoIds },
      );
      // 保持分と繋がらない (別タブで limit 以上追記された / 分岐が変わった) ときは、
      // 欠落区間を取ってから最新ページを適用する。表示は保持分のまま待つ
      if (bundle.gap) {
        return {
          ...state,
          history: {
            ...state.history,
            supported: true,
            gapCursor: page.items[0]?.id ?? null,
            pendingPage: page.items.length > 0 ? page : null,
          },
        };
      }
      return attachRunToolCards(applyHistoryMerge(state, bundle, page), state.runStatus === "running");
    }

    case "historyGap": {
      const pending = state.history.pendingPage;
      // 古い応答 / 別の保留ページで解決済みなら何もしない
      if (!pending || state.history.gapCursor !== action.cursor) return state;
      const bundle = {
        bubbles: state.bubbles,
        markers: state.dividers,
        nextId: state.nextId,
        toolBubbleIds: state.toolBubbleIds,
      };
      const live = state.bubbles.filter((bubble) => bubble.entryId === undefined);
      // 1) 欠落区間のページを保持分へ適用する (繋がらなければ 1 ページに収まらない欠落)
      const gapMerge = mergeHistoryPage(bundle, action.page, { live, pendingEchoIds: state.pendingEchoIds });
      // 2) 保留していた最新ページを適用する
      if (!gapMerge.gap) {
        const latestMerge = mergeHistoryPage(gapMerge, pending, {
          live: gapMerge.bubbles.filter((bubble) => bubble.entryId === undefined),
          pendingEchoIds: gapMerge.pendingEchoIds,
        });
        if (!latestMerge.gap) {
          return attachRunToolCards(applyHistoryMerge(state, latestMerge, pending), state.runStatus === "running");
        }
      }
      // 3) 欠落区間が 1 ページに収まらない / 分岐が変わった。取ってある gap ページは
      //    保留ページと連続しているので捨てずに組み込み、カーソルを gap ページ側へ進める
      //    (同じ before を再取得しない)
      if (action.page.items.length > 0) {
        const rebuilt = rebuildHistoryPage(bundle, action.page, { live, pendingEchoIds: state.pendingEchoIds });
        const withPending = mergeHistoryPage(rebuilt, pending, {
          live: rebuilt.bubbles.filter((bubble) => bubble.entryId === undefined),
          pendingEchoIds: rebuilt.pendingEchoIds,
        });
        // メタデータ (nextCursor / hasMore / counts) は古い方 (= gap ページ) を正とする
        if (!withPending.gap) {
          return attachRunToolCards(applyHistoryMerge(state, withPending, action.page), state.runStatus === "running");
        }
      }
      return attachRunToolCards(
        applyHistoryMerge(
          state,
          rebuildHistoryPage(bundle, pending, { live, pendingEchoIds: state.pendingEchoIds }),
          pending,
        ),
        state.runStatus === "running",
      );
    }

    case "historyGapFailed": {
      if (state.history.gapCursor !== action.cursor) return state;
      return { ...state, history: { ...state.history, gapCursor: null, pendingPage: null } };
    }

    case "prependHistory": {
      const page = action.page;
      // 取得中にブランチ / 保持分の先頭が変わっていたら、旧ブランチのページを混ぜない
      if (state.history.nextCursor !== action.cursor) return state;
      const bundle = prependHistoryPage(
        {
          bubbles: state.bubbles,
          markers: state.dividers,
          nextId: state.nextId,
          toolBubbleIds: state.toolBubbleIds,
          messageCount: state.history.messageCount,
          summarizedMessageCount: state.history.summarizedMessageCount,
        },
        page,
        { pendingEchoIds: state.pendingEchoIds },
      );
      return {
        ...state,
        bubbles: bundle.bubbles,
        dividers: bundle.markers,
        nextId: bundle.nextId,
        toolBubbleIds: bundle.toolBubbleIds,
        pendingEchoIds: bundle.pendingEchoIds,
        prependSeq: state.prependSeq + (bundle.prepended > 0 ? 1 : 0),
        history: {
          ...state.history,
          supported: true,
          hasMore: page.hasMore,
          nextCursor: page.nextCursor,
          loading: false,
          messageCount: page.messageCount,
          summarizedMessageCount: page.summarizedMessageCount,
          activeContextStartId: page.activeContextStartId,
        },
      };
    }

    case "historyLoading":
      return { ...state, history: { ...state.history, loading: action.loading } };

    case "historyUnsupported": {
      const next = { ...state, history: { ...state.history, supported: false, unsupported: true } };
      if (action.payload === undefined) return next;
      // ライブの本文・送信エコーや取得済みページがある間は、payload からの組み直しで消さない。
      // 未取得の legacy 表示だけを全量へ差し替える（次の resync でも unsupported を見て全量を組む）
      const hasLive = state.bubbles.some((bubble) => bubble.entryId === undefined && bubble.legacy !== true);
      if (hasLive || holdsFetchedHistory(state)) return next;
      // payload は古い実行状態を含み得るため、resync として適用せず表示に必要な分だけを写す
      const bundle = historyToBubbles(state.nextId, action.payload.messages ?? []);
      return {
        ...next,
        bubbles: bundle.bubbles,
        nextId: bundle.nextId,
        toolBubbleIds: bundle.toolBubbleIds,
        dividers: legacyMarkers(action.payload.compactions ?? []),
        compactions: action.payload.compactions ?? [],
        context: action.payload.context,
      };
    }
  }
}
