import type { ChatState } from "../hooks/chatReducer";
import { MODEL_UNSET_GUIDE } from "./modelSettings";
import { pendingAskUserQuestionCount } from "./askUser";
import { sessionBusy } from "./sessionBusy";
import type { SettingsSelection } from "../hooks/settingsChange";
import type { AgentDef, Health, ModelOption, ModelRef, ThinkingLevel } from "../types";

/** Effort の全段階 (使用モデルの候補を引けないときの表示に使う) */
export const ALL_THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const EFFORT_LABELS: Record<ThinkingLevel, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "xHigh",
  max: "Max",
};

export function effortLabel(level: string): string {
  return EFFORT_LABELS[level as ThinkingLevel] ?? level;
}

const effortRank = (level: string): number => ALL_THINKING_LEVELS.indexOf(level as ThinkingLevel);

/** 段階として知らない値は末端へ置きたいので、順位の無いものは最大段階より後ろへ寄せる */
const orderRank = (level: string): number => {
  const rank = effortRank(level);
  return rank === -1 ? ALL_THINKING_LEVELS.length : rank;
};

/**
 * そのモデルが扱えない段階を、扱える段階へ寄せる。規則は pi-ai の clampThinkingLevel と同じ
 * (要求より上へ探し、見つからなければ下へ探す) で、未作成チャットの表示を作成時の実効値に先に揃える。
 * ブラウザにはモデルの実体が無く候補の段階だけを受け取るため、SDK の clampThinkingLevel は使えない。
 */
export function clampEffortLevel(level: ThinkingLevel | undefined, levels: ThinkingLevel[]): ThinkingLevel | undefined {
  if (!level || levels.includes(level)) return level;
  const requested = effortRank(level);
  if (requested === -1) return levels[0] ?? level;
  for (let i = requested; i < ALL_THINKING_LEVELS.length; i++) {
    const candidate = ALL_THINKING_LEVELS[i];
    if (levels.includes(candidate)) return candidate;
  }
  for (let i = requested - 1; i >= 0; i--) {
    const candidate = ALL_THINKING_LEVELS[i];
    if (levels.includes(candidate)) return candidate;
  }
  return levels[0] ?? level;
}

/**
 * Effort の選択肢。候補に無い現在値も表示できるようにするが、段階順は崩さない
 * (末尾へ足すと Max より後ろに別の段階が並び、最上段が Max でなくなる)。
 */
export function effortChoices(levels: ThinkingLevel[], current?: string): ThinkingLevel[] {
  const list =
    current && !levels.includes(current as ThinkingLevel) ? [...levels, current as ThinkingLevel] : [...levels];
  return list.sort((a, b) => orderRank(a) - orderRank(b));
}

/** 入力欄付近の Model / Effort ピッカーに渡す状態 */
export type ComposerSettings = {
  modelOptions: ModelOption[];
  model?: string;
  /** トリガーに出す表示名 (候補を引ければ ModelOption.name、引けなければ provider/id) */
  modelLabel?: string;
  /** トリガーに出す Effort のラベル (ピッカーと同じ effortLabel())。モデル名の右へ `- xHigh` と続けて出す。推論非対応とモデル未解決では出さない */
  effortLabel?: string;
  thinkingLevel?: string;
  supportsThinking: boolean;
  thinkingLevels: ThinkingLevel[];
  modelWarning?: string;
  effortNotice?: string;
  /** 生成中・キュー待ち・設定変更通信中は選択を無効化する */
  disabled: boolean;
  /** 設定変更通信中は送信も待たせる */
  changing: boolean;
  /** 手動圧縮ボタンを押せない (実効 busy / 送信中 / 設定変更中) */
  compactDisabled: boolean;
  /** 押せない理由。状態行の下に 1 行で出し (touch でも読める)、aria-describedby の参照先にもする */
  compactDisabledReason?: string;
  /** 未作成チャットで有効なモデルが無いときの、送信しても作成できない理由 */
  sendBlockedReason?: string;
};

export type ComposerSettingsInput = {
  health: Health | null;
  selectedAgent?: AgentDef;
  sessionId: string;
  preselection: SettingsSelection;
  chat: Pick<
    ChatState,
    "sessionModel" | "sessionThinkingLevel" | "supportsThinking" | "availableThinkingLevels" | "runStatus" | "runTools"
  >;
  sending: boolean;
  settingsChanging: boolean;
  stopVisible: boolean;
};

/**
 * 手動圧縮の実効 busy。集合は `sessionBusy` が正で、ここは圧縮の可否という意味を名前で残すだけ。
 * `statusOf` は streaming を running として返し、idle 相当でも completed / stopped / error を返すため、
 * runStatus === "idle" では判定できない。
 */
export function compactionBusy(runStatus: string): boolean {
  return sessionBusy(runStatus);
}

/** 手動圧縮を押せない理由。順序は実際に遮っているもの (圧縮中 > 実行中 > 送信中 > 設定変更中) */
function compactDisabledReason(input: {
  runStatus: string;
  sending: boolean;
  settingsChanging: boolean;
}): string | undefined {
  if (input.runStatus === "compacting") return "圧縮中";
  if (compactionBusy(input.runStatus)) return "実行中";
  if (input.sending) return "送信中";
  if (input.settingsChanging) return "設定の変更中";
  return undefined;
}

const modelLabel = (ref?: ModelRef): string | undefined => (ref ? `${ref.provider}/${ref.id}` : undefined);

/**
 * Model / Effort ピッカーの表示値を導出する。セッションの作成待ち・設定変更の通信状態とは独立に、
 * 与えられた入力だけから決まる。
 */
export function deriveComposerSettings(input: ComposerSettingsInput): ComposerSettings {
  const { health, selectedAgent, sessionId, preselection, chat, sending, settingsChanging, stopVisible } = input;
  const modelOptions = health?.modelOptions ?? [];
  const findOption = (label?: string): ModelOption | undefined =>
    label ? modelOptions.find((option) => `${option.provider}/${option.id}` === label) : undefined;

  const inSession = Boolean(sessionId);
  // 作成済みセッションの実効値は resync で chat に入る。runtimeStatus は health の再取得で上書きされるため使わない。
  // 未作成チャットはサーバーと同じ優先順位 (作成前の選択 → 定義 → アプリ既定) で表示する
  const pendingModel = modelLabel(preselection.model) ?? modelLabel(selectedAgent?.model) ?? health?.model;

  const model = inSession ? chat.sessionModel : pendingModel;
  const option = findOption(model);
  const pendingLevels = option?.thinkingLevels ?? ALL_THINKING_LEVELS;
  // 情報源 (作成前の選択 → 定義 → アプリ既定) の値がモデルの段階に無いことがある。作成時に SDK が
  // 寄せる値と同じものを見せるため clamp し、選べない段階を Effort の候補へ混ぜない。
  // セッションの実効値は SDK が補正済みなので触らない。
  const pendingThinkingLevel = clampEffortLevel(
    preselection.thinkingLevel ?? selectedAgent?.thinkingLevel ?? health?.defaultThinkingLevel,
    pendingLevels,
  );
  const thinkingLevel = inSession ? chat.sessionThinkingLevel : pendingThinkingLevel;
  const supportsThinking = inSession ? chat.supportsThinking : (option?.supportsThinking ?? true);
  // 推論に対応しないモデルの実効 Effort は SDK が常に "off" を返し、モデル名が未解決のときは付ける相手が無い
  const statusEffort = model && supportsThinking && thinkingLevel ? effortLabel(thinkingLevel) : undefined;

  // 回答待ちの質問がある間は、回答を本文へ打たずカードへ入れてもらう (待機キューに積まれる事故を防ぐ)。
  // 送信の遮断は composerSettings が 1 箇所で担い、Composer は理由を footnote に出すだけにする
  const pendingQuestions = pendingAskUserQuestionCount(chat.runTools, chat.runStatus);

  return {
    modelOptions,
    model,
    // トリガーに出す表示名も同じ 1 回の解決から出す (候補を引ければ SDK の表示名)
    modelLabel: model ? (option?.name ?? model) : undefined,
    effortLabel: statusEffort,
    thinkingLevel,
    supportsThinking,
    thinkingLevels: inSession ? chat.availableThinkingLevels : pendingLevels,
    modelWarning: model && !option ? `${model} は現在利用できません。別のモデルを選択してください。` : undefined,
    effortNotice: option ? undefined : "使用モデルに応じて補正されます",
    disabled: stopVisible || sending || settingsChanging,
    changing: settingsChanging,
    // 送信の通信中も止める (送信と同時に押すと run の開始と競合する)
    compactDisabled: compactionBusy(chat.runStatus) || sending || settingsChanging,
    compactDisabledReason: compactDisabledReason({ runStatus: chat.runStatus, sending, settingsChanging }),
    sendBlockedReason:
      pendingQuestions > 0
        ? `上の質問に回答してください（${pendingQuestions}件）`
        : !inSession && !model
          ? // トリガーが無効になる理由は、入力欄の下の footnote にも出す必要がある (無効なボタンは
            // touch で hover も title も読めない)。health.error は認証必須 / availability / 初期化失敗を持つ
            (health?.defaultModelError ?? (health?.defaultModelUnset ? MODEL_UNSET_GUIDE : health?.error))
          : undefined,
  };
}
