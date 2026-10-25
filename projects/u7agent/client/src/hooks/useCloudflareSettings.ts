import { useCallback, useState } from "react";
import {
  checkCloudflareConnection,
  deleteCloudflareSettings,
  getCloudflareSettings,
  updateCloudflareSettings,
} from "../api";
import { messageFor } from "../lib/settingsResource";
import type {
  CloudflareConnectionCheckResponse,
  CloudflareSettingsResponse,
  UpdateCloudflareSettingsBody,
} from "../types";
import { createGenerationTracker, createLoadingTracker, createRequestGate } from "./requestGate";
import { useSettingsResource } from "./useSettingsResource";

const DEFAULT_NOTE = "Cloudflare の資格情報はこのサーバーだけが保持し、エージェントやサンドボックスへは渡しません。";
const LOAD_ERROR = "Cloudflare の設定を読み込めませんでした。";

/**
 * 設定 → 共有 → 接続 の state。GET はアカウント ID と登録状態だけで、トークンは応答に載らない。
 * 保存の応答も同じ形なので、成功後は画面がアカウント ID だけを追随させる。
 * 接続確認は明示操作でだけ走り、結果を保存しない（`note` にも載せない）。
 */
export function useCloudflareSettings() {
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<CloudflareConnectionCheckResponse | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  // 破棄された確認でも「確認中」を解除するため、適用の可否とは別に追う
  const [checkTracker] = useState(() => createLoadingTracker(setChecking));
  // 確認中に設定が変わったら、遅れて届いた結果を適用しない
  const [checkGeneration] = useState(createGenerationTracker);
  const [beginCheck] = useState(createRequestGate);

  const { settings, note, saving, reloading, reload, runMutation } = useSettingsResource<
    CloudflareSettingsResponse,
    "save" | "delete"
  >({
    defaultNote: DEFAULT_NOTE,
    loadErrorLabel: LOAD_ERROR,
    load: getCloudflareSettings,
    onApply: useCallback(() => {
      checkGeneration.invalidate();
      setCheckResult(null);
      setCheckError(null);
    }, [checkGeneration]),
  });

  const save = useCallback(
    (input: UpdateCloudflareSettingsBody) =>
      runMutation("save", "Cloudflare の資格情報を保存しました。", () => updateCloudflareSettings(input)),
    [runMutation],
  );

  const remove = useCallback(
    () => runMutation("delete", "Cloudflare の資格情報を削除しました。", deleteCloudflareSettings),
    [runMutation],
  );

  const check = useCallback(async (): Promise<void> => {
    const canApply = beginCheck();
    const generation = checkGeneration.begin();
    const finishCheck = checkTracker.begin();
    setCheckResult(null);
    setCheckError(null);
    try {
      const result = await checkCloudflareConnection();
      if (!canApply() || !checkGeneration.holds(generation)) return;
      // 別タブで接続が変わっていた場合、前の接続の結果を今の入力の結果に見せない
      if (result.accountId !== settings?.accountId) return;
      setCheckResult(result);
    } catch (error) {
      if (!canApply() || !checkGeneration.holds(generation)) return;
      setCheckError(messageFor(error));
    } finally {
      finishCheck();
    }
  }, [beginCheck, checkGeneration, checkTracker, settings?.accountId]);

  return { settings, note, saving, reloading, reload, save, remove, checking, checkResult, checkError, check };
}

export type CloudflareSettings = ReturnType<typeof useCloudflareSettings>;
