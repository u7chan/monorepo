/**
 * チャット設定変更の応答適用。設定変更 API は非同期で返るため、待機中に別のチャットへ切替わっていることがある。
 * 各 await の後に選択中かを確かめ、古い応答で切替後の表示 (履歴 / Model / Effort / lastSeq / 活動表示) を上書きしない。
 */
import type { ModelRef, SessionPayload, ThinkingLevel } from "../types";

/** 作成前の選択と設定変更リクエストで共通の指定 */
export type SettingsSelection = {
  model?: ModelRef;
  thinkingLevel?: ThinkingLevel;
};

export interface SettingsChangeDeps {
  /** 要求時に捕捉したセッションがまだ選択中か */
  isCurrentSession: () => boolean;
  request: (sessionId: string, selection: SettingsSelection) => Promise<SessionPayload>;
  /** 失敗時にサーバーの実効状態（GET /api/sessions/:id）を取り直す */
  recover: (sessionId: string) => Promise<SessionPayload>;
  applyPayload: (payload: SessionPayload) => void;
  onSuccess: () => void;
  onError: (error: unknown) => void;
}

/**
 * 応答が返った時点でまだ同じチャットが選ばれているときだけ表示を更新し、切替済みの応答は破棄する。
 */
export async function applySettingsChange(
  sessionId: string,
  selection: SettingsSelection,
  deps: SettingsChangeDeps,
): Promise<void> {
  try {
    const payload = await deps.request(sessionId, selection);
    if (!deps.isCurrentSession()) return; // 切替済み: 古い成功応答は適用しない
    deps.applyPayload(payload);
    deps.onSuccess();
  } catch (error) {
    // 失敗時はサーバーの実効状態へ戻す。回復 GET の待機中にも切替があり得る。
    if (deps.isCurrentSession()) {
      try {
        const payload = await deps.recover(sessionId);
        if (deps.isCurrentSession()) deps.applyPayload(payload);
      } catch {
        // セッションが消えている場合は onClosed 側の再選択に任せる
      }
    }
    if (!deps.isCurrentSession()) return; // 切替済み: 活動表示や runtimeStatus も触らない
    deps.onError(error);
  }
}
