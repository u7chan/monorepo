// 実行 (run) の開始から終端までと、その間に届く本文・usage・状態を受け持つ。
import { canonicalUserText, fallbackEchoTarget, rebuildToolBubbleIds } from "../lib/chatHistory";
import type { Bubble, CompactionMarker } from "../lib/chatTypes";
import { retryableRunError, runErrorFrom } from "../lib/runRetry";
import { runOutcomeOf } from "../lib/turnEnd";
import type { RunStatus } from "../types";
import type { ChatAction, ChatState } from "../lib/chatState";
import {
  QUEUE_CLEARED,
  attachAssistantTurnEnd,
  attachUserTurnEnd,
  mergeRetrySnapshot,
  normalizeInitialSend,
  updateBubble,
  withoutQueuedSnapshots,
} from "./chatReducerShared";
import {
  attachRunToolCards,
  carryToolCardsToAnswers,
  closeCurrentAssistant,
  ensureAssistant,
  openAssistantForKey,
  settleToolHosts,
  toolHostOf,
} from "./chatCards";

/**
 * run_start に対応する自分の user entry が既に履歴へ載っているか (送信直前の preflight compaction など)。
 * 送信の run id が分かるときは runId が一致する item だけを見るので、別クライアントの同一文面 entry を
 * 自分のものにしない。run id が無い旧経路は、送信時点 (`echo.since`) より後に現れた runId 無しの
 * 同一文面へ縮退する (`fallbackEchoTarget`)。
 */
function echoAbsorbTarget(bubbles: Bubble[], markers: CompactionMarker[], echo: Bubble): Bubble | undefined {
  const live = (bubble: Bubble) => bubble.entryId !== undefined && bubble.role === "user";
  // 送信IDが分かるエコーは同じ送信IDの item だけへ吸収する (同じ実行の別の送信と取り違えない)
  if (echo.sendId !== undefined) {
    return bubbles.find((bubble) => live(bubble) && bubble.sendId === echo.sendId);
  }
  if (echo.runId !== undefined) {
    // 旧サーバーの item は送信IDを持たない。run の最初の user item へ従来どおり縮退する
    return bubbles.find((bubble) => live(bubble) && bubble.sendId === undefined && bubble.runId === echo.runId);
  }
  return fallbackEchoTarget(bubbles, markers, echo);
}

/** 繰り上げの結果を状態へ写す。消したバブルの補完先を指したままにしない */
function withCarriedToolCards(state: ChatState): ChatState {
  const { bubbles, dropped } = carryToolCardsToAnswers(state.bubbles, state.currentAssistantId);
  const currentDropped = state.currentAssistantId !== null && dropped.has(state.currentAssistantId);
  return {
    ...state,
    bubbles,
    toolBubbleIds: rebuildToolBubbleIds(bubbles),
    currentAssistantId: currentDropped ? null : state.currentAssistantId,
    currentAssistantKey: currentDropped ? undefined : state.currentAssistantKey,
    toolTargetAssistantId:
      state.toolTargetAssistantId !== undefined && dropped.has(state.toolTargetAssistantId)
        ? undefined
        : state.toolTargetAssistantId,
  };
}

function insertRunUser(
  state: ChatState,
  text: string,
  at: number | undefined,
  runId: string | undefined,
  initialSendId: string | undefined,
): ChatState {
  const bubble: Bubble = {
    id: state.nextId,
    role: "user",
    text,
    tools: [],
    skillLoads: [],
    at,
    ...(runId === undefined ? {} : { runId }),
    ...(initialSendId === undefined ? {} : { sendId: initialSendId }),
  };
  let insertAt = state.bubbles.length;
  const prefix = runId === undefined ? undefined : `${runId}:`;
  if (prefix !== undefined) {
    const early = state.bubbles.findIndex(
      (item) => item.role === "assistant" && item.assistantId?.startsWith(prefix) === true,
    );
    if (early !== -1) insertAt = early;
  }
  if (insertAt === state.bubbles.length && state.currentAssistantId !== null) {
    const current = state.bubbles.find((item) => item.id === state.currentAssistantId);
    if (current?.role === "assistant" && current.assistantId === undefined && current.settled !== true) {
      insertAt = state.bubbles.findIndex((item) => item.id === current.id);
    }
  }
  return {
    ...state,
    bubbles: [...state.bubbles.slice(0, insertAt), bubble, ...state.bubbles.slice(insertAt)],
    nextId: state.nextId + 1,
  };
}

function patchAssistant(state: ChatState, update: (bubble: Bubble) => Bubble): ChatState {
  if (state.currentAssistantId === null) return state;
  return updateBubble(state, state.currentAssistantId, update);
}

const RUN_PROMPT_LIMIT = 16;

/** run_start の本文を run id で控える。応答が遅れて届いてもエコーへ反映できるよう直近分だけ持つ */
function rememberRunPrompt(prompts: Record<string, string>, runId: string, prompt: string): Record<string, string> {
  const next = { ...prompts, [runId]: prompt };
  const keys = Object.keys(next);
  for (const key of keys.slice(0, Math.max(0, keys.length - RUN_PROMPT_LIMIT))) delete next[key];
  return next;
}

/**
 * host を次の表示可能な本文 item にする。確定履歴の投影は本文を持つ item にツールを繰り上げるので、
 * 同じカード (同じ id) のまま `assistantId` と本文だけを足せば、ライブと確定後でヘッダーの位置・
 * 高さ・件数・プレビューが変わらない。host の印は run が終わるまで残す: 本文 item を引き取った後も
 * そのターンの一部で、`run_end` までは実行中のカードとコピーを出さない。
 */
function adoptToolHost(state: ChatState, assistantKey: string): ChatState | undefined {
  const host = toolHostOf(state.bubbles);
  if (host === undefined) return undefined;
  // run が変わっていたら (断絶中の run 切替を resync で知らないまま採用した)
  // 前の run の控えは引き継がない。同じ run の採用なら積む
  const runId = state.currentRunId ?? runIdOfAssistantId(assistantKey);
  const kept = state.liveHostRunId === runId ? state.liveHostAssistantIds : [];
  return {
    ...state,
    bubbles: state.bubbles.map((bubble) => (bubble.id === host.id ? { ...bubble, assistantId: assistantKey } : bubble)),
    currentAssistantId: host.id,
    currentAssistantKey: assistantKey,
    toolTargetAssistantId: undefined,
    liveHostAssistantIds: [...new Set([...kept, assistantKey])],
    liveHostRunId: runId,
  };
}

/** 応答ID (`<runId>:<seq>`) から run id を引く。形式が違う旧データは undefined */
function runIdOfAssistantId(assistantId: string): string | undefined {
  const separator = assistantId.lastIndexOf(":");
  return separator > 0 ? assistantId.slice(0, separator) : undefined;
}

/** 実行の開始から終端までを受け持つアクション (この関数へ委譲する種別だけを抜き出す) */
type RunChatAction = Extract<
  ChatAction,
  {
    type: "runStart" | "runEnd" | "setRun" | "retry" | "usage" | "status" | "assistantEnd" | "text" | "thinkingCleared";
  }
>;

export function applyRunAction(state: ChatState, action: RunChatAction): ChatState {
  switch (action.type) {
    case "runStart": {
      // 自分の送信を実行する run は run id で厳密に照合する。run id が分からないエコー (応答待ち) は
      // 照合せず保持し、別クライアントの同一文面 entry を誤って自分のものにしない。
      // 未送信 / 受理済みのバブルは、この run_start で「サーバーが実行を開始した」ことを確認済みに
      // する (楽観的に再送したバブルも含める。遅れて届いた失敗で未送信へ戻さない)。待機中
      // (`queued`) のバブルは送信応答だけが run id を付けているため、ここで合わせて拾う
      const started = state.bubbles.find(
        (bubble) =>
          bubble.entryId === undefined &&
          (action.initialSendId !== undefined
            ? bubble.sendId === action.initialSendId
            : action.runId !== undefined && bubble.runId === action.runId) &&
          (bubble.unsent === true || bubble.accepted === true || bubble.queued === true),
      );
      const startedBubble =
        started === undefined
          ? undefined
          : { ...started, unsent: false, accepted: true, confirmed: true, ...QUEUE_CLEARED };
      // 待機から実行に移った送信は末尾へ移す。実行中ターンがまだ assistant バブルを作っていない窓では、
      // 最初の delta がこの送信より後ろへ応答を積むため、ここで揃えないと実行に移った瞬間に前の応答の
      // 途中へ現れる (他のバブルの相対順は変えない)
      const moveStartedToEnd = started?.queued === true;
      const base =
        startedBubble === undefined
          ? state
          : {
              ...state,
              bubbles: moveStartedToEnd
                ? [...state.bubbles.filter((bubble) => bubble.id !== startedBubble.id), startedBubble]
                : state.bubbles.map((bubble) => (bubble.id === startedBubble.id ? startedBubble : bubble)),
              pendingEchoIds: state.pendingEchoIds.includes(startedBubble.id)
                ? state.pendingEchoIds
                : [...state.pendingEchoIds, startedBubble.id],
            };
      const promptBody = canonicalUserText(action.prompt);
      const echoIndex =
        action.initialSendId !== undefined
          ? base.pendingEchoIds.findIndex(
              (id) => base.bubbles.find((item) => item.id === id)?.sendId === action.initialSendId,
            )
          : action.runId !== undefined
            ? base.pendingEchoIds.findIndex((id) => base.bubbles.find((item) => item.id === id)?.runId === action.runId)
            : base.pendingEchoIds.findIndex((id) => {
                const bubble = base.bubbles.find((item) => item.id === id);
                return bubble !== undefined && canonicalUserText(bubble.text) === promptBody;
              });
      const echo = echoIndex === -1 ? undefined : base.bubbles.find((b) => b.id === base.pendingEchoIds[echoIndex]);
      // 対応が取れた 1 件だけ待ち行列から外す。run id 不明の旧経路は送信順に届く前提を保つ
      const pendingEchoIds =
        echoIndex === -1
          ? base.pendingEchoIds
          : action.initialSendId !== undefined || action.runId !== undefined
            ? base.pendingEchoIds.filter((_, index) => index !== echoIndex)
            : base.pendingEchoIds.slice(echoIndex + 1);
      const pending = new Set(base.pendingEchoIds);
      let next: ChatState;
      if (echo !== undefined) {
        const absorb = echoAbsorbTarget(base.bubbles, base.dividers, echo);
        if (absorb !== undefined) {
          // preflight compaction などで自分の entry が既に履歴へ載っている。エコーを履歴 item へ
          // 吸収し、同じ発言の二重表示を防ぐ
          next = { ...base, bubbles: base.bubbles.filter((bubble) => bubble.id !== echo.id) };
        } else {
          next =
            echo.text === action.prompt
              ? base
              : updateBubble(base, echo.id, (bubble) => ({ ...bubble, text: action.prompt }));
        }
      } else {
        // 待ち行列のエコーが本文の正規形で一致するなら、自分の run_start が応答より先に届いた場合なので
        // 二重に足さない (別クライアントの同一文面はページの item を正とする)
        const known =
          base.bubbles.some((bubble) => bubble.role === "user" && bubble.text === action.prompt) ||
          base.bubbles.some((bubble) => pending.has(bubble.id) && canonicalUserText(bubble.text) === promptBody);
        next = known ? base : insertRunUser(base, action.prompt, action.at, action.runId, action.initialSendId);
      }
      // 前の run のツールだけの host は確定履歴の item 境界へ揃えて確定する (本文 item が来ないまま
      // run_end を取りこぼしていても、次の run のカードを前のターンの host へ混ぜない)
      const settled = settleToolHosts(next);
      return {
        ...settled,
        pendingEchoIds,
        // run_start の本文を控えておく。応答が遅れて届いたエコーを展開後の本文へ差し替えるのに使う
        runPrompts:
          action.runId === undefined
            ? next.runPrompts
            : rememberRunPrompt(next.runPrompts, action.runId, action.prompt),
        runInitialSendIds:
          action.runId === undefined || action.initialSendId === undefined
            ? next.runInitialSendIds
            : { ...next.runInitialSendIds, [action.runId]: action.initialSendId },
        currentAssistantId: null,
        currentAssistantKey: undefined,
        toolBubbleIds: {},
        runTools: {},
        runStatus: "running",
        runStartedAt: action.startedAt,
        // 圧縮の終端では run_start より先に終端 resync が届く (回復時も残さない)
        compactionStartedAt: undefined,
        activity: "実行を開始しました",
        activityState: undefined,
        // 前の run の tail を引き継がない
        thinkingText: undefined,
        // 前の run の保留値・再試行状態を引き継がない (累計は結果表示用に残す)
        pendingUsage: undefined,
        pendingMetrics: undefined,
        retry: undefined,
        retryRemainingMs: undefined,
        retryReceivedAt: undefined,
        retryCount: 0,
        // 前のランの失敗は引き継がない (新しいランの開始でカードを消す)
        runError: undefined,
        // 待機列の先頭が実行に移った瞬間だけ、リングを 1 回広げてチップを一瞬 `実行中` にする
        startingRunId: started?.queued === true ? action.runId : undefined,
        currentRunId: action.runId,
        toolTargetAssistantId: undefined,
        // 前の run の host を次の run のページ再構築で復元しない
        liveHostAssistantIds: [],
        liveHostRunId: undefined,
        closedAssistantTexts:
          action.runId !== undefined && action.runId === state.currentRunId ? state.closedAssistantTexts : [],
        stateSeq: state.stateSeq + 1,
        queuedSnapshots:
          action.initialSendId === undefined
            ? state.queuedSnapshots
            : withoutQueuedSnapshots(state.queuedSnapshots, [action.initialSendId]),
        // 実行が始まった送信は停止の控えから外す (遅れて届いた 202 で未送信へ戻さない)
        clearedSendIds: (() => {
          // 旧サーバーは開始送信IDを配らないため run id で縮退する
          const started = action.initialSendId ?? action.runId;
          return started === undefined ? next.clearedSendIds : next.clearedSendIds.filter((id) => id !== started);
        })(),
      };
    }

    case "text": {
      // 本文が来たら thinking の末尾は用済み (旧サーバー / 取りこぼした status への保険)
      if (state.thinkingText !== undefined) state = { ...state, thinkingText: undefined };
      const key = action.assistantId;
      if (key !== undefined) {
        const existing = state.bubbles.find((bubble) => bubble.role === "assistant" && bubble.assistantId === key);
        if (existing !== undefined) {
          const withTarget = {
            ...state,
            currentAssistantId: existing.id,
            currentAssistantKey: key,
            toolTargetAssistantId: undefined,
          };
          const withBubble = attachRunToolCards(withTarget, false);
          return patchAssistant(withBubble, (b) => ({ ...b, text: b.text + (action.delta || "") }));
        }
        // ツールだけの host があれば、そのカードをこの本文 item にする (確定履歴と同じ形)
        const opened = adoptToolHost(closeCurrentAssistant(state), key) ?? openAssistantForKey(state, action.at, key);
        const withBubble = attachRunToolCards(opened, false);
        return patchAssistant(withBubble, (b) => ({ ...b, text: b.text + (action.delta || "") }));
      }
      // 旧サーバーの delta は従来どおり開いている応答へ積む
      const withBubble = attachRunToolCards(ensureAssistant(state, action.at), false);
      return patchAssistant(withBubble, (b) => ({ ...b, text: b.text + (action.delta || "") }));
    }

    case "assistantEnd": {
      if (state.thinkingText !== undefined) state = { ...state, thinkingText: undefined };
      const key = action.assistantId;
      const target =
        key !== undefined
          ? state.bubbles.find((bubble) => bubble.role === "assistant" && bubble.assistantId === key)
          : state.currentAssistantId === null
            ? undefined
            : state.bubbles.find((bubble) => bubble.id === state.currentAssistantId);
      if (target === undefined) {
        if (key !== undefined) {
          // 本文なしの ask_user など、まだバブルが無い応答の確定モデルは応答IDごとに控える。
          // 後から合成するバブル (ensureAssistant / appendOwnedAssistant) が同じキーを読む
          return action.model === undefined
            ? state
            : {
                ...state,
                assistantMeta: {
                  ...state.assistantMeta,
                  [key]: { ...state.assistantMeta[key], assistantId: key, model: action.model },
                },
              };
        }
        return state.toolTargetAssistantId === undefined
          ? state
          : { ...state, currentAssistantId: null, currentAssistantKey: undefined, toolTargetAssistantId: undefined };
      }
      const closesCurrent =
        state.currentAssistantId === target.id || (key !== undefined && state.currentAssistantKey === key);
      // 本文の応答が確定した時点で、同じターンの本文なし応答のカードをこの応答へ寄せる (投影と同じ所有者)
      return withCarriedToolCards({
        ...state,
        currentAssistantId: closesCurrent ? null : state.currentAssistantId,
        currentAssistantKey: closesCurrent ? undefined : state.currentAssistantKey,
        toolTargetAssistantId: closesCurrent ? target.id : state.toolTargetAssistantId,
        bubbles: state.bubbles.map((bubble) =>
          bubble.id === target.id
            ? { ...bubble, settled: true, ...(action.model === undefined ? {} : { model: action.model }) }
            : bubble,
        ),
        closedAssistantTexts:
          key !== undefined || target.text === ""
            ? state.closedAssistantTexts
            : [...new Set([...state.closedAssistantTexts, target.text])],
      });
    }

    case "usage": {
      // ツールループは 1 バブルに統合されるため、後続メッセージの値で上書きされる (仕様)。
      const next = action.context ? { ...state, context: action.context } : state;
      const keyTarget =
        action.assistantId === undefined
          ? undefined
          : state.bubbles.find((bubble) => bubble.role === "assistant" && bubble.assistantId === action.assistantId);
      if (keyTarget !== undefined) {
        return updateBubble(next, keyTarget.id, (b) => ({
          ...b,
          usage: action.usage ?? b.usage,
          metrics: action.metrics ?? b.metrics,
        }));
      }
      if (action.assistantId !== undefined) {
        return {
          ...next,
          pendingUsage: action.usage ?? state.pendingUsage,
          pendingMetrics: action.metrics ?? state.pendingMetrics,
        };
      }
      if (state.currentAssistantId !== null) {
        return updateBubble(next, state.currentAssistantId, (b) => ({
          ...b,
          usage: action.usage ?? b.usage,
          metrics: action.metrics ?? b.metrics,
        }));
      }
      // まだ本文もツールカードも届いていない (tool 呼び出しだけの message_end が先に届く)。
      // 直前の run のバブルを書き換えず、値を保留して次に作るバブルへ回す。
      return {
        ...next,
        pendingUsage: action.usage ?? state.pendingUsage,
        pendingMetrics: action.metrics ?? state.pendingMetrics,
      };
    }

    case "status": {
      // state は演出の条件 (thinking のときだけ活動ラベルに光を流す)、text は表示文言。
      // thinking の末尾は live 専用で、載っていない status は tail のクリアを意味する
      const thinkingText = action.state === "thinking" && action.thinking ? action.thinking : undefined;
      return {
        ...state,
        activity: action.text || "処理中…",
        activityState: action.state || undefined,
        thinkingText,
      };
    }

    case "thinkingCleared":
      // 切断した tail を見せ続けない。領域は次の delta のために残す
      return state.thinkingText === undefined ? state : { ...state, thinkingText: undefined };

    case "retry": {
      const retryState = mergeRetrySnapshot(state, action.retry, action.serverNow, action.receivedAt);
      return {
        ...state,
        ...retryState,
        retryCount: action.totalRetryCount,
        // 再試行の待機は生成中ではない (状態行の文言はクライアントが導出する)
        activityState: undefined,
      };
    }

    case "runEnd": {
      const { status, queueDepth } = action;
      // 自分の run が終わったら、その run のエコーは run_start 待ちを卒業する (履歴 item に run id が
      // 載らない縮退時は、ページ到着時に本文での突き合わせへ戻す)
      const initialSendId = action.runId === undefined ? undefined : state.runInitialSendIds[action.runId];
      const pendingEchoIds =
        action.runId === undefined
          ? state.pendingEchoIds
          : state.pendingEchoIds.filter((id) => {
              const bubble = state.bubbles.find((item) => item.id === id);
              if (bubble === undefined) return true;
              return initialSendId !== undefined ? bubble.sendId !== initialSendId : bubble.runId !== action.runId;
            });
      // 失敗の分類コードは status === "error" のときだけ保持する (停止と例外が同時でもカードを出さない)
      const runError = runErrorFrom(status, action.errorCode, action.error);
      const runStatus: RunStatus = queueDepth > 0 ? "queued" : status === "completed" ? "idle" : status;
      // カードを出すときだけ状態行のエラー文言を空にし、同じ 1 文を二重に出さない。
      // キュー待ちを挟んだ run は queued なのでカードを出さず、現行の文言を維持する
      const cardShown = retryableRunError(runStatus, runError) !== undefined;
      let activity: string;
      if (status === "stopped") activity = "停止しました";
      else if (status === "error") activity = cardShown ? "" : `エラー: ${action.error || "実行に失敗しました"}`;
      // 件数はコンポーザー直上のブロックが正なので、活動の語だけで示す
      else activity = "完了";
      // 確定した応答のバブルは resync でも残す (履歴ページが届くまでの表示を維持する)
      const settledCurrent =
        state.currentAssistantId === null
          ? state
          : updateBubble(state, state.currentAssistantId, (bubble) => ({ ...bubble, settled: true }));
      // 本文 item が現れないまま run が終わったターンは、host を確定履歴の item 境界へ揃えて確定する
      // (本文を持たない応答ごとに 1 item。投影と同じ形にして、resync / F5 でヘッダーが動かないようにする)
      const settled = settleToolHosts(settledCurrent);
      // run_end の所要時間と結末は、その run の user パブルへ写す (entryId の有無を問わず runId 一致)。
      // 未送信のターンは導出側が行を落とす。終端以外の status では値を付けない
      const outcome = runOutcomeOf(status);
      const normalized = normalizeInitialSend(settled.bubbles, initialSendId);
      const withTurnEnd =
        action.runId === undefined || outcome === undefined || action.durationMs === undefined
          ? { ...settled, bubbles: normalized }
          : {
              ...settled,
              bubbles: attachUserTurnEnd(normalized, action.runId, initialSendId, outcome, action.durationMs),
            };
      const bubbles =
        action.runId === undefined || outcome === undefined || action.durationMs === undefined
          ? withTurnEnd.bubbles
          : attachAssistantTurnEnd(
              withTurnEnd.bubbles,
              action.runId,
              initialSendId,
              outcome,
              action.durationMs,
              state.currentAssistantId,
            );
      // assistant_end を取りこぼしても、run が終われば本文の応答は確定している (投影と同じ所有者へ寄せる)
      const carriedBubbles = carryToolCardsToAnswers(bubbles, state.currentAssistantId).bubbles;
      return {
        ...withTurnEnd,
        bubbles: carriedBubbles,
        pendingEchoIds,
        stateSeq: state.stateSeq + 1,
        currentAssistantId: null,
        currentAssistantKey: undefined,
        currentRunId: undefined,
        closedAssistantTexts: [],
        toolTargetAssistantId: undefined,
        // ターンが終われば host は確定済みの item になる (次の resync で印を戻さない)
        liveHostAssistantIds: [],
        liveHostRunId: undefined,
        toolBubbleIds: {},
        activity,
        activityState: undefined,
        // run が終わったら tail を落とす
        thinkingText: undefined,
        // 開始直後の演出は run の終了でも必ず落とす
        startingRunId: undefined,
        // run が終わったことを取り直しの合図として数える (描画を挟まず reducer で進める)
        runEndSeq: withTurnEnd.runEndSeq + 1,
        runStartedAt: undefined,
        compactionStartedAt: undefined,
        runStatus,
        queueDepth,
        // 履歴反映後の最新値 (usage イベントの context は 1 応答分古い)
        context: action.context ?? state.context,
        // バブルが作られないまま run が終わった保留値は、次の run へ持ち越さない
        pendingUsage: undefined,
        pendingMetrics: undefined,
        // アクティブな再試行は終了で消す。累計は結果表示のため残す
        retry: undefined,
        retryRemainingMs: undefined,
        retryReceivedAt: undefined,
        retryCount: action.totalRetryCount ?? state.retryCount,
        runError,
        // 実行を開始した送信は、停止の控えから外す (遅れて届いた 202 で未送信へ戻さない)
        clearedSendIds:
          initialSendId === undefined
            ? withTurnEnd.clearedSendIds
            : withTurnEnd.clearedSendIds.filter((id) => id !== initialSendId),
        // 終わった実行の対応は残さない (同じ run id は再利用しない)
        runInitialSendIds: (() => {
          if (action.runId === undefined) return withTurnEnd.runInitialSendIds;
          const next = { ...withTurnEnd.runInitialSendIds };
          delete next[action.runId];
          return next;
        })(),
      };
    }

    case "setRun":
      // 要求後に終端や次の run が入っていれば、遅れて届いた停止応答で状態 (実行状態・待機件数・
      // 活動文言) を戻さない。描画を挟まない同じバッチでも順序が決まるよう reducer で判定する
      if (action.stateSeq !== undefined && action.stateSeq !== state.stateSeq) return state;
      return {
        ...state,
        runStatus: action.runStatus,
        // 圧縮の起点は resync が持つ。応答などで compacting 以外へ移すときは残さない
        compactionStartedAt: action.runStatus === "compacting" ? state.compactionStartedAt : undefined,
        queueDepth: action.queueDepth ?? state.queueDepth,
        activity: action.activity ?? state.activity,
        // 応答で権威ある状態へ移した時点で演出も外す (status が来ない経路で光り続けない)
        activityState: undefined,
        // 送信の応答や停止の応答で権威ある状態へ移った時点でカードを消す (run_start が遅れても古い失敗を残さない)
        runError: undefined,
      };
  }
}
