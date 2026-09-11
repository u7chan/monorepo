/**
 * ヘッダーのモデル表示。選択中セッションの実効モデルとアプリ既定は別物なので出所をラベルで示す。
 * 表示は状態に持たず毎レンダー導出し、health の再取得や応答順で会話モデル表示を上書きさせない。
 */

export type ModelDisplaySource = "session" | "default";

/** 表示しているモデルの出所を短く示すラベル */
export const MODEL_DISPLAY_LABELS: Record<ModelDisplaySource, string> = {
  session: "会話",
  default: "既定",
};

export interface ModelDisplay {
  /** provider/id */
  model: string;
  /** 表示しているモデルの出所 */
  source: ModelDisplaySource;
  /** 出所の短いラベル (「会話」「既定」) */
  label: string;
}

export interface ModelDisplayInput {
  /** 選択中セッションがあるか */
  inSession: boolean;
  /** 選択中セッションの実効モデル (SessionPayload.model) */
  sessionModel?: string;
  /** サーバーのアプリ既定モデル (health.model) */
  defaultModel?: string;
}

export function modelDisplayOf({
  inSession,
  sessionModel,
  defaultModel,
}: ModelDisplayInput): ModelDisplay | undefined {
  if (inSession) {
    // 会話モデルが取れないときに既定モデルへフォールバックすると、送信に使うモデルと食い違って見える。
    if (!sessionModel) return undefined;
    return { model: sessionModel, source: "session", label: MODEL_DISPLAY_LABELS.session };
  }
  if (!defaultModel) return undefined;
  // 未作成のチャットではアプリ既定を「既定」と明示して出す。
  return { model: defaultModel, source: "default", label: MODEL_DISPLAY_LABELS.default };
}
