/**
 * チャット設定変更の応答適用。
 *
 * 設定変更 API の応答は非同期で返るため、待機中にユーザーが別のチャットへ
 * 切り替えていることがある。各 await の後に「要求したセッションがまだ選択中か」
 * を確認し、古い応答で切替後のチャットの表示 (履歴 / Model / Effort / lastSeq /
 * 活動表示) を上書きしない。
 */
import type { ModelRef, SessionPayload, ThinkingLevel } from "../types";

/** 作成前の選択と設定変更リクエストで共通の指定 */
export type SettingsSelection = {
  model?: ModelRef;
  thinkingLevel?: ThinkingLevel;
};

export interface SettingsChangeDeps {
  /** 要求時に捕捉したセッションがまだ現在の選択か */
  isCurrentSession: () => boolean;
  /** PATCH /api/sessions/:id/settings */
  request: (sessionId: string, selection: SettingsSelection) => Promise<SessionPayload>;
  /** 失敗時にサーバーの実効状態を取り直す GET /api/sessions/:id */
  recover: (sessionId: string) => Promise<SessionPayload>;
  /** 取得したペイロードを表示へ反映する */
  applyPayload: (payload: SessionPayload) => void;
  onSuccess: () => void;
  onError: (error: unknown) => void;
}

/**
 * 設定変更を実行する。応答が返った時点でまだ同じチャットが選ばれている場合だけ
 * 表示を更新し、切替済みの応答は破棄する。
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
