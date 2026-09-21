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
  thinkingLevel?: string;
  supportsThinking: boolean;
  thinkingLevels: ThinkingLevel[];
  modelWarning?: string;
  effortNotice?: string;
  /** 生成中・キュー待ち・設定変更通信中は選択を無効化する */
  disabled: boolean;
  /** 設定変更通信中は送信も待たせる */
  changing: boolean;
  /** 未作成チャットで有効なモデルが無いときの、送信しても作成できない理由 */
  sendBlockedReason?: string;
};

export type ComposerSettingsInput = {
  health: Health | null;
  selectedAgent?: AgentDef;
  sessionId: string;
  preselection: SettingsSelection;
  chat: Pick<ChatState, "sessionModel" | "sessionThinkingLevel" | "supportsThinking" | "availableThinkingLevels">;
  sending: boolean;
  settingsChanging: boolean;
  stopVisible: boolean;
};

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
    thinkingLevel: inSession ? chat.sessionThinkingLevel : pendingThinkingLevel,
    supportsThinking: inSession ? chat.supportsThinking : (option?.supportsThinking ?? true),
    thinkingLevels: inSession ? chat.availableThinkingLevels : (option?.thinkingLevels ?? ALL_THINKING_LEVELS),
    modelWarning: model && !option ? `${model} は現在利用できません。別のモデルを選択してください。` : undefined,
    effortNotice: option ? undefined : "使用モデルに応じて補正されます",
    disabled: stopVisible || sending || settingsChanging,
    changing: settingsChanging,
    sendBlockedReason: !inSession && !model && health?.defaultModelError ? health.defaultModelError : undefined,
  };
}
