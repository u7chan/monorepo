import { useCallback } from "react";
import { deleteCloudflareSettings, getCloudflareSettings, updateCloudflareSettings } from "../api";
import type { CloudflareSettingsResponse, UpdateCloudflareSettingsBody } from "../types";
import { useSettingsResource } from "./useSettingsResource";

const DEFAULT_NOTE = "Cloudflare の資格情報はこのサーバーだけが保持し、エージェントやサンドボックスへは渡しません。";
const LOAD_ERROR = "Cloudflare の設定を読み込めませんでした。";

/**
 * 設定 → 共有 → 接続 の state。GET はアカウント ID と登録状態だけで、トークンは応答に載らない。
 * 保存の応答も同じ形なので、成功後は画面がアカウント ID だけを追随させる。
 */
export function useCloudflareSettings() {
  const { settings, note, saving, reloading, reload, runMutation } = useSettingsResource<
    CloudflareSettingsResponse,
    "save" | "delete"
  >({
    defaultNote: DEFAULT_NOTE,
    loadErrorLabel: LOAD_ERROR,
    load: getCloudflareSettings,
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

  return { settings, note, saving, reloading, reload, save, remove };
}

export type CloudflareSettings = ReturnType<typeof useCloudflareSettings>;
