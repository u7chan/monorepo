import type { ChatState } from "../hooks/chatReducer";
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

/** 入力欄付近の Model / Effort ピッカーに渡す状態 */
export type ComposerSettings = {
  modelOptions: ModelOption[];
  model?: string;
  /** 状態行に出す表示名 (候補を引ければ ModelOption.name、引けなければ provider/id) */
  modelLabel?: string;
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
  /** 押せない理由。圧縮の注意書きに付け足し、aria-describedby でも読ませる */
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
    "sessionModel" | "sessionThinkingLevel" | "supportsThinking" | "availableThinkingLevels" | "runStatus"
  >;
  sending: boolean;
  settingsChanging: boolean;
  stopVisible: boolean;
};

/**
 * 手動圧縮の実効 busy。`statusOf` は streaming を running として返し、idle 相当でも
 * completed / stopped / error を返すため、runStatus === "idle" では判定できない。
 */
export function compactionBusy(runStatus: string): boolean {
  return runStatus === "running" || runStatus === "queued" || runStatus === "compacting";
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
  const pendingThinkingLevel =
    preselection.thinkingLevel ?? selectedAgent?.thinkingLevel ?? health?.defaultThinkingLevel;

  const model = inSession ? chat.sessionModel : pendingModel;
  const option = findOption(model);

  return {
    modelOptions,
    model,
    // 状態行の表示名も同じ 1 回の解決から出す (ピッカーを閉じていても実効モデルが分かるように)
    modelLabel: model ? (option?.name ?? model) : undefined,
    thinkingLevel: inSession ? chat.sessionThinkingLevel : pendingThinkingLevel,
    supportsThinking: inSession ? chat.supportsThinking : (option?.supportsThinking ?? true),
    thinkingLevels: inSession ? chat.availableThinkingLevels : (option?.thinkingLevels ?? ALL_THINKING_LEVELS),
    modelWarning: model && !option ? `${model} は現在利用できません。別のモデルを選択してください。` : undefined,
    effortNotice: option ? undefined : "使用モデルに応じて補正されます",
    disabled: stopVisible || sending || settingsChanging,
    changing: settingsChanging,
    // 送信の通信中も止める (送信と同時に押すと run の開始と競合する)
    compactDisabled: compactionBusy(chat.runStatus) || sending || settingsChanging,
    compactDisabledReason: compactDisabledReason({ runStatus: chat.runStatus, sending, settingsChanging }),
    sendBlockedReason: !inSession && !model && health?.defaultModelError ? health.defaultModelError : undefined,
  };
}
