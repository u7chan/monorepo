// ライブで積む応答カードと、ツールカードの持ち主を決める規則。履歴 / 実行 / ツールの各群が共有する。
import { rebuildToolBubbleIds, toolCardOf } from "../lib/chatHistory";
import { isPendingAskUser } from "../lib/askUser";
import { isToolHostBubble } from "../lib/chatTypes";
import type { Bubble, ToolCard } from "../lib/chatTypes";
import type { ToolCall } from "../types";
import type { ChatState } from "../lib/chatState";
import { appendBubble, updateBubble } from "./chatReducerShared";

/**
 * 本文なし応答のカードを、同じターンで次に確定した本文の応答へ寄せる。履歴の投影は本文なし応答の
 * ツールを同ターン内の次の表示メッセージへ繰り上げるので、ライブが古い持ち主のままだと同じ記録を
 * 読み直した表示と所有者が食い違う。本文が確定する前と、本文が現れないターンでは動かさない。
 */
export function carryToolCardsToAnswers(
  bubbles: Bubble[],
  keepId: number | null,
): { bubbles: Bubble[]; dropped: Set<number> } {
  const targets = new Map<number, number>();
  let owners: Bubble[] = [];
  for (const bubble of bubbles) {
    if (bubble.role === "user") {
      owners = [];
      continue;
    }
    if (bubble.role !== "assistant") continue;
    // 確定した本文だけを繰り上げ先にする。ストリーミング中に移すと、保存前の再読み込みで戻る
    if (bubble.text !== "" && (bubble.settled === true || bubble.entryId !== undefined)) {
      for (const owner of owners) targets.set(owner.id, bubble.id);
      owners = [];
      continue;
    }
    if (bubble.text === "" && bubble.tools.length > 0) owners.push(bubble);
  }
  if (targets.size === 0) return { bubbles, dropped: new Set() };
  const carried = new Map<number, ToolCard[]>();
  const bubbleById = new Map(bubbles.map((bubble) => [bubble.id, bubble]));
  // 移し先に既にある call は足さない (履歴が assistant_end を追い越すと履歴由来のカードが先に載る)
  const knownOf = new Map<number, Set<string>>();
  const knownOn = (targetId: number): Set<string> => {
    const known = knownOf.get(targetId);
    if (known !== undefined) return known;
    const ids = new Set(bubbleById.get(targetId)?.tools.map((card) => card.id) ?? []);
    knownOf.set(targetId, ids);
    return ids;
  };
  for (const [ownerId, targetId] of targets) {
    const owner = bubbleById.get(ownerId);
    if (owner === undefined) continue;
    const known = knownOn(targetId);
    const moved = owner.tools.filter((card) => {
      if (known.has(card.id)) return false;
      known.add(card.id);
      return true;
    });
    if (moved.length === 0) continue;
    carried.set(targetId, [...(carried.get(targetId) ?? []), ...moved]);
  }
  const dropped = new Set<number>();
  const next: Bubble[] = [];
  for (const bubble of bubbles) {
    const moved = carried.get(bubble.id);
    if (moved !== undefined) {
      // 投影と同じく、繰り上げ分をこの応答の part より先に並べる
      next.push({ ...bubble, tools: [...moved, ...bubble.tools] });
      continue;
    }
    if (targets.has(bubble.id)) {
      // カードを移した本文なし応答は、履歴 item / 導出行 / 結末を持つときだけ器として残す
      if (
        bubble.id === keepId ||
        bubble.entryId !== undefined ||
        bubble.skillLoads.length > 0 ||
        bubble.turnEnd !== undefined
      ) {
        next.push({ ...bubble, tools: [] });
      } else {
        dropped.add(bubble.id);
      }
      continue;
    }
    next.push(bubble);
  }
  return { bubbles: next, dropped };
}

/** at は生成元イベントの時刻 */
export function ensureAssistant(state: ChatState, at?: number, assistantKey?: string): ChatState {
  if (state.currentAssistantId !== null && state.bubbles.some((b) => b.id === state.currentAssistantId)) {
    return state;
  }
  const next = appendBubble(state, "assistant", "", at);
  const bubbleId = next.nextId - 1;
  // ツール呼び出しだけの応答は usage の方が先に届くので、ここで作ったバブルへ回す
  const meta = assistantKey === undefined ? undefined : next.assistantMeta[assistantKey];
  const withMeta =
    next.pendingUsage || next.pendingMetrics || meta?.model !== undefined
      ? updateBubble(next, bubbleId, (bubble) => ({
          ...bubble,
          usage: next.pendingUsage,
          metrics: next.pendingMetrics,
          ...(meta?.model === undefined ? {} : { model: meta.model }),
        }))
      : next;
  return {
    ...withMeta,
    bubbles: withMeta.bubbles.map((bubble) =>
      bubble.id === bubbleId && assistantKey !== undefined ? { ...bubble, assistantId: assistantKey } : bubble,
    ),
    currentAssistantId: bubbleId,
    currentAssistantKey: assistantKey,
    toolTargetAssistantId: undefined,
    pendingUsage: undefined,
    pendingMetrics: undefined,
  };
}

/**
 * 応答IDが変わったら前のカードを閉じて新しいカードを開く。assistant_end を取りこぼしても
 * 次の delta が前の応答へ連結されないようにする
 */
export function openAssistantForKey(
  state: ChatState,
  at: number | undefined,
  assistantKey: string | undefined,
): ChatState {
  if (assistantKey === undefined) return ensureAssistant(state, at);
  if (state.currentAssistantId !== null) {
    const current = state.bubbles.find((bubble) => bubble.id === state.currentAssistantId);
    if (current !== undefined && current.assistantId !== assistantKey) {
      return ensureAssistant(
        {
          ...state,
          bubbles: state.bubbles.map((bubble) => (bubble.id === current.id ? { ...bubble, settled: true } : bubble)),
          currentAssistantId: null,
          currentAssistantKey: undefined,
          toolTargetAssistantId: current.id,
        },
        at,
        assistantKey,
      );
    }
  }
  return ensureAssistant(state, at, assistantKey);
}

export function attachCardTo(state: ChatState, card: ToolCard, bubbleId: number): ChatState {
  return {
    ...updateBubble(state, bubbleId, (bubble) => ({ ...bubble, tools: [...bubble.tools, card] })),
    toolBubbleIds: { ...state.toolBubbleIds, [card.id]: bubbleId },
  };
}

/**
 * 今の run の「ツールだけの host」(まだ本文 item を引き取っていないカード)。確定履歴は本文を持たない
 * 応答のツールを同ターンの次の表示可能な本文 item へ繰り上げるため、ライブもその本文 item が現れる
 * まで 1 枚のカードに溜める。待機・未送信のエコーは host の後ろに積まれることがあるので、配列の
 * 末尾ではなく host の印で引く (配列の位置をターン境界にしない)。
 */
export function toolHostOf(bubbles: Bubble[]): Bubble | undefined {
  for (let index = bubbles.length - 1; index >= 0; index -= 1) {
    const bubble = bubbles[index];
    if (isToolHostBubble(bubble) && bubble.text === "") return bubble;
  }
  return undefined;
}

/**
 * run 中の host (本文 item を引き取った後も含む)。溜め先 (`toolHostOf`) と違い本文の有無を問わず、
 * 本文の補完先にしない対象を引く
 */
function markedToolHostOf(bubbles: Bubble[]): Bubble | undefined {
  for (let index = bubbles.length - 1; index >= 0; index -= 1) {
    if (isToolHostBubble(bubbles[index])) return bubbles[index];
  }
  return undefined;
}

/**
 * ツールカードを溜める host を用意する (既にあれば同じカードへ積む)。host は本文 item ではないので
 * 本文の補完先 (`currentAssistantId`) にはしない。代わりに `toolTargetAssistantId` を指し、以降の
 * ツールを閉じた応答として受けられるようにする。本文を持たない応答の usage / metrics は表示する行が
 * 無いため、ここで保留値を捨てて次の本文 item の数値と混ぜない。
 */
export function ensureToolHost(state: ChatState, at?: number): { state: ChatState; id: number } {
  const existing = toolHostOf(state.bubbles);
  if (existing !== undefined) {
    return {
      state: { ...state, toolTargetAssistantId: existing.id, pendingUsage: undefined, pendingMetrics: undefined },
      id: existing.id,
    };
  }
  const appended = appendBubble(state, "assistant", "", at);
  const id = appended.nextId - 1;
  // 本文を持たない応答の usage / metrics は表示する item が無いので、host へ写さない。
  // run id は履歴の照合で使う (本文を持たないので、空文字の一致だけで別ターンへ対応付けさせない)
  return {
    state: {
      ...appended,
      bubbles: appended.bubbles.map((bubble) =>
        bubble.id === id
          ? {
              ...bubble,
              host: true as const,
              ...(state.currentRunId === undefined ? {} : { runId: state.currentRunId }),
            }
          : bubble,
      ),
      toolTargetAssistantId: id,
      pendingUsage: undefined,
      pendingMetrics: undefined,
    },
    id,
  };
}

/** assistant_end を取りこぼしても、次の応答のツールを前の応答へ混ぜない (本文の補完先も外す) */
export function closeCurrentAssistant(state: ChatState): ChatState {
  if (state.currentAssistantId === null) return state;
  const id = state.currentAssistantId;
  return {
    ...state,
    bubbles: state.bubbles.map((bubble) => (bubble.id === id ? { ...bubble, settled: true } : bubble)),
    currentAssistantId: null,
    currentAssistantKey: undefined,
    toolTargetAssistantId: id,
  };
}

/** host のカードを所有者 (本文を持たない応答) ごとに分ける。順序はカードが届いた順 */
function toolCardGroups(
  tools: readonly ToolCard[],
  runTools: ChatState["runTools"],
): { assistantId?: string; cards: ToolCard[] }[] {
  const groups: { assistantId?: string; cards: ToolCard[] }[] = [];
  for (const card of tools) {
    const owner = runTools[card.id]?.assistantId;
    const group = groups.find((entry) => entry.assistantId === owner);
    if (group === undefined) groups.push({ assistantId: owner, cards: [card] });
    else group.cards.push(card);
  }
  return groups.length === 0 ? [{ cards: [] }] : groups;
}

/**
 * run が終わったターンの host を、確定履歴の item 境界へ揃えて確定する。投影は本文を持たない応答を
 * それぞれ 1 item (自分のツールだけを持つ) にするため、複数応答のツールを 1 枚にまとめたまま残すと
 * resync / F5 でヘッダーの数・件数・位置が変わってしまう。本文 item を引き取った host はそのまま
 * 1 item として確定し、ライブの印 (host) を外す。
 */
export function settleToolHosts(state: ChatState): ChatState {
  if (!state.bubbles.some(isToolHostBubble)) return state;
  const bubbles: Bubble[] = [];
  let nextId = state.nextId;
  for (const bubble of state.bubbles) {
    if (!isToolHostBubble(bubble)) {
      bubbles.push(bubble);
      continue;
    }
    const groups =
      bubble.text === ""
        ? toolCardGroups(bubble.tools, state.runTools)
        : [{ assistantId: bubble.assistantId, cards: bubble.tools }];
    groups.forEach((group, index) => {
      bubbles.push({
        ...bubble,
        // 1 枚目は元のバブル (DOM の位置) をそのまま使う
        id: index === 0 ? bubble.id : nextId++,
        settled: true,
        host: undefined,
        assistantId: group.assistantId,
        tools: group.cards,
      });
    });
  }
  return { ...state, bubbles, nextId, toolBubbleIds: rebuildToolBubbleIds(bubbles) };
}

/**
 * 補完先 = 最後の user バブルより後にある最後の assistant バブル。無ければ undefined (保留)。
 * entryId の有無を問わず、履歴ページ適用後の確定バブルにもライブの生成中バブルにも補う。
 */
function currentTurnAssistantId(bubbles: Bubble[]): number | undefined {
  let lastUser = -1;
  for (let index = bubbles.length - 1; index >= 0; index -= 1) {
    if (bubbles[index].role === "user") {
      lastUser = index;
      break;
    }
  }
  for (let index = bubbles.length - 1; index > lastUser; index -= 1) {
    if (bubbles[index].role === "assistant") return bubbles[index].id;
  }
  return undefined;
}

/**
 * 本文を持たない応答は履歴 item に現れないため、所有者IDのカードを合成しないと ID 付きの call が
 * 結び付かず、再接続でツールカードが消える (本文の追記先は変えない)。
 */
function appendOwnedAssistant(state: ChatState, ownerKey: string | undefined): { state: ChatState; id: number } {
  const id = state.nextId;
  // 履歴 item を持たない応答なので、payload が応答単位で配るメタ情報だけを写す (run の開始時刻や
  // 再読み込み時刻で代用すると、生成時間の行が別の値になる)。無い項目はそのまま欠ける
  const meta = ownerKey === undefined ? undefined : state.assistantMeta[ownerKey];
  const usage = state.pendingUsage ?? meta?.usage;
  const metrics = state.pendingMetrics ?? meta?.metrics;
  const bubble: Bubble = {
    id,
    role: "assistant",
    text: "",
    tools: [],
    skillLoads: [],
    settled: true,
    ...(ownerKey === undefined ? {} : { assistantId: ownerKey }),
    ...(meta?.at === undefined ? {} : { at: meta.at }),
    ...(meta?.model !== undefined ? { model: meta.model } : {}),
    ...(usage === undefined ? {} : { usage }),
    ...(metrics === undefined ? {} : { metrics }),
  };
  return {
    state: {
      ...state,
      bubbles: [...state.bubbles, bubble],
      nextId: id + 1,
      pendingUsage: undefined,
      pendingMetrics: undefined,
    },
    id,
  };
}

/**
 * run 側のツール状態を現在ターンの assistant バブルへ反映する。補完先が無いときは補完せず
 * 保持だけする (保留)。ページを組み直す位置から呼ぶので、ID で突き合わせてべき等にする。
 * focus は true のときだけ currentAssistantId を補完先へ向ける。呼び出し側は実行中かどうかで決める
 * (完了したターンを指すと、そのバブルが live 扱いのままになり履歴側のコピーが戻らない)。
 */
export function attachRunToolCards(state: ChatState, focus: boolean): ChatState {
  const calls = Object.values(state.runTools);
  if (calls.length === 0) return state;
  // 本文を持たない応答のカードは、所有者ごとの空カードを作らず今ターンの host へ溜める。確定履歴は
  // 同じターンの次の表示可能な本文 item へ繰り上げるので、その item が現れるまで持ち主を決めない
  for (const call of calls) {
    if (call.assistantId === undefined || state.toolBubbleIds[call.id] !== undefined) continue;
    const owned = state.bubbles.some(
      (bubble) => bubble.role === "assistant" && bubble.assistantId === call.assistantId,
    );
    if (owned) continue;
    if (isPendingAskUser(call)) {
      // 回答待ちの ask_user は本文も結果も無く履歴 item にならない。応答メタ (時刻 / usage) と
      // 応答IDを持つ空のカードを合成し、回答できる状態を再接続でも保つ
      state = appendOwnedAssistant(state, call.assistantId).state;
      continue;
    }
    const host = ensureToolHost(state);
    state = attachCardTo(host.state, toolCardOf(call), host.id);
  }
  // 開いている応答を優先し、無ければ assistant_end で閉じた応答へ付ける
  const existing = (id: number | null | undefined): id is number =>
    id !== undefined && id !== null && state.bubbles.some((bubble) => bubble.id === id);
  let targetId = existing(state.currentAssistantId)
    ? state.currentAssistantId
    : existing(state.toolTargetAssistantId)
      ? state.toolTargetAssistantId
      : currentTurnAssistantId(state.bubbles);
  // 本文も応答IDも持たない旧データの回答待ちでは補完先が無い。待機中は次のイベントが来ず
  // 自己回復しないので、ここだけ assistant バブルを合成する
  if (targetId === undefined) {
    if (!calls.some(isPendingAskUser)) return state;
    const appended = appendOwnedAssistant(state, undefined);
    state = appended.state;
    targetId = appended.id;
  }
  const attached = attachToolCalls(state, targetId, calls);
  // 閉じた応答を focus で開き直すと、次の delta がそのカードへ連結される。host は本文 item ではないので
  // 本文の補完先にしない (次の本文は host を引き取って同じカードを item にする)
  const target = state.bubbles.find((bubble) => bubble.id === targetId);
  const hostId = markedToolHostOf(state.bubbles)?.id;
  const focusable =
    targetId !== state.toolTargetAssistantId && target !== undefined && target.settled !== true && targetId !== hostId;
  return focus && focusable
    ? { ...attached, currentAssistantId: targetId, currentAssistantKey: target?.assistantId }
    : attached;
}

function attachToolCalls(state: ChatState, bubbleId: number, toolCalls: ToolCall[]): ChatState {
  let next = state;
  for (const call of toolCalls) {
    const card = toolCardOf(call);
    const existingBubbleId = next.toolBubbleIds[call.id];
    if (existingBubbleId !== undefined) {
      // 履歴と run が重なる瞬間は run の位相が正なので、所属バブルを保ってカードを更新する。
      next = updateBubble(next, existingBubbleId, (bubble) => ({
        ...bubble,
        tools: bubble.tools.map((existing) => (existing.id === call.id ? card : existing)),
      }));
      continue;
    }
    // 要求元の応答IDが分かるカードは、その応答が見つかるまで置かない (別の応答へ移さない)
    const ownerId =
      call.assistantId === undefined
        ? undefined
        : next.bubbles.find((bubble) => bubble.role === "assistant" && bubble.assistantId === call.assistantId)?.id;
    if (call.assistantId !== undefined && ownerId === undefined) continue;
    const targetId = ownerId ?? bubbleId;
    next = {
      ...updateBubble(next, targetId, (bubble) => ({ ...bubble, tools: [...bubble.tools, card] })),
      toolBubbleIds: { ...next.toolBubbleIds, [call.id]: targetId },
    };
  }
  return next;
}
