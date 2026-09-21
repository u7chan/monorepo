/**
 * チャット設定変更の応答適用。設定変更 API は非同期で返るため、待機中に別のチャットへ切替わっていることがある。
 * 各 await の後に選択中かを確かめ、古い応答で切替後の表示 (履歴 / Model / Effort / lastSeq / 活動表示) を上書きしない。
 */
import type { ModelRef, SessionPayload, ThinkingLevel } from "../types";

export type SettingsSelection = {
  model?: ModelRef;
  thinkingLevel?: ThinkingLevel;
};

export interface SettingsChangeDeps {
  isCurrentSession: () => boolean;
  request: (sessionId: string, selection: SettingsSelection) => Promise<SessionPayload>;
  recover: (sessionId: string) => Promise<SessionPayload>;
  applyPayload: (payload: SessionPayload) => void;
  onSuccess: () => void;
  onError: (error: unknown) => void;
}

export async function applySettingsChange(
  sessionId: string,
  selection: SettingsSelection,
  deps: SettingsChangeDeps,
): Promise<void> {
  try {
    const payload = await deps.request(sessionId, selection);
    if (!deps.isCurrentSession()) return;
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
    if (!deps.isCurrentSession()) return; // 切替済みの応答では活動表示や runtimeStatus も触らない
    deps.onError(error);
  }
}
