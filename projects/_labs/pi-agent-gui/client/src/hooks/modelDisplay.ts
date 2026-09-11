/**
 * ヘッダーのモデル表示。
 *
 * 選択中セッションの実効モデル（会話モデル）と、サーバー（アプリ）の既定モデルは
 * 別物なので、どちらを表示しているかをラベルで明示する。表示は health 再取得や
 * 設定変更の応答順に左右されないよう状態として持たず、毎レンダーで導出する
 * (health がサーバー既定モデルで会話モデル表示を上書きしないため)。
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
    // 会話モデルが取れないときに既定モデルへフォールバックしない。表示だけが
    // サーバー既定に化けると、送信に使われるモデルと食い違って見える。
    if (!sessionModel) return undefined;
    return { model: sessionModel, source: "session", label: MODEL_DISPLAY_LABELS.session };
  }
  if (!defaultModel) return undefined;
  // 未作成のチャットではアプリ既定を「既定」と明示して出す。
  return { model: defaultModel, source: "default", label: MODEL_DISPLAY_LABELS.default };
}
