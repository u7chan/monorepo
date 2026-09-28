import { useCallback, useEffect, useState } from "react";
import {
  ApiError,
  deleteProviderApiKey,
  getModelsSettings,
  getRuntimeModels,
  putModelAvailability,
  putProviderApiKey,
  putProviderMemo,
  resyncProviderApiKey,
} from "../api";
import {
  MODEL_SETTINGS_NOTE,
  mutationNote,
  validateApiKey,
  validateMemo,
  type MutationAction,
} from "../lib/modelSettings";
import type {
  Health,
  ModelMutationResponse,
  ModelsSettingsResponse,
  RuntimeModelsResponse,
  UpdateModelAvailabilityBody,
} from "../types";
import { createLoadingTracker, createRequestGate } from "./requestGate";

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type ModelSettingsParams = {
  /** APIキーの変更後に composer のモデル候補を更新する (health は親が持つ) */
  onRefreshHealth: (isCurrent?: () => boolean) => Promise<Health | null>;
};

/**
 * 設定 → モデルの state と操作。GET (設定) と GET (カタログ) は独立に取り、片方の失敗で
 * 他方を捨てない。変更系の応答は GET と同じ形なので、注記を付けてそのまま次の状態にできる。
 */
export function useModelSettings({ onRefreshHealth }: ModelSettingsParams) {
  const [settings, setSettings] = useState<ModelsSettingsResponse | null>(null);
  const [catalog, setCatalog] = useState<RuntimeModelsResponse | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; error: boolean }>({ text: MODEL_SETTINGS_NOTE, error: false });
  const [saving, setSaving] = useState<string | null>(null);
  const [savingAvailability, setSavingAvailability] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [beginLoad] = useState(createRequestGate);
  // 破棄された取得でも進行中を解除するため、適用の可否とは別に追う
  const [reloadTracker] = useState(() => createLoadingTracker(setReloading));

  /** カタログだけ取り直す (モデル数と一覧の表示を変更直後に追随させる) */
  const loadCatalog = useCallback(async (canApply: () => boolean) => {
    try {
      const next = await getRuntimeModels();
      if (!canApply()) return;
      setCatalog(next);
      setCatalogError(null);
    } catch (error) {
      if (!canApply()) return;
      // 診断が取れない状態 (503) でも設定 API の表示は保つ
      setCatalog(null);
      setCatalogError(messageFor(error));
    }
  }, []);

  const reload = useCallback(async (): Promise<void> => {
    const canApply = beginLoad();
    const finishReload = reloadTracker.begin();
    try {
      const [settingsResult] = await Promise.allSettled([getModelsSettings()]);
      if (!canApply()) return;
      if (settingsResult.status === "fulfilled") {
        setSettings(settingsResult.value);
        setNote({ text: MODEL_SETTINGS_NOTE, error: false });
      } else {
        setNote({ text: `モデルの設定を読み込めませんでした。${messageFor(settingsResult.reason)}`, error: true });
      }
      await loadCatalog(canApply);
    } finally {
      finishReload();
    }
  }, [beginLoad, loadCatalog, reloadTracker]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** 変更系の応答を適用し、health とカタログを取り直す (composer のモデル候補を追随させる) */
  const applyMutation = useCallback(
    async (action: MutationAction, response: ModelMutationResponse) => {
      // 進行中の読み込みの応答で、いま適用した応答を上書きさせない
      const canApply = beginLoad();
      setSettings(response);
      setNote(mutationNote(action, response));
      await onRefreshHealth(canApply);
      await loadCatalog(canApply);
    },
    [beginLoad, loadCatalog, onRefreshHealth],
  );

  const runMutation = useCallback(
    async (provider: string, action: MutationAction, run: () => Promise<ModelMutationResponse>): Promise<boolean> => {
      setSaving(provider);
      try {
        await applyMutation(action, await run());
        return true;
      } catch (error) {
        // 何も保存されなかった (503 not_stored / 400) ことを文言で区別する
        const prefix = error instanceof ApiError && error.state === "not_stored" ? "変更は保存されていません。" : "";
        setNote({ text: `${prefix}${messageFor(error)}`, error: true });
        return false;
      } finally {
        setSaving(null);
      }
    },
    [applyMutation],
  );

  const save = useCallback(
    async (provider: string, apiKey: string): Promise<boolean> => {
      const invalid = validateApiKey(apiKey);
      if (invalid) {
        setNote({ text: invalid, error: true });
        return false;
      }
      return runMutation(provider, "save", () => putProviderApiKey(provider, apiKey));
    },
    [runMutation],
  );

  /** 利用可能なモデルの一括保存。確認は純関数の判定を受けてコンポーネントが先に出す */
  const saveAvailability = useCallback(
    async (input: UpdateModelAvailabilityBody): Promise<ModelsSettingsResponse | null> => {
      setSavingAvailability(true);
      try {
        const response = await putModelAvailability(input);
        await applyMutation("availability", response);
        return response;
      } catch (error) {
        // 何も保存されなかった (503 not_stored / 400) ことを文言で区別する
        const prefix = error instanceof ApiError && error.state === "not_stored" ? "変更は保存されていません。" : "";
        setNote({ text: `${prefix}${messageFor(error)}`, error: true });
        return null;
      } finally {
        setSavingAvailability(false);
      }
    },
    [applyMutation],
  );

  const remove = useCallback(
    (provider: string): Promise<boolean> => runMutation(provider, "delete", () => deleteProviderApiKey(provider)),
    [runMutation],
  );

  /**
   * provider メモの保存。SDK に触れないため health / カタログの再取得は通さないが、
   * 進行中の reload() の応答で保存直後の設定を上書きされないよう、先行ロードは無効化する。
   */
  const saveMemo = useCallback(
    async (provider: string, memo: string): Promise<boolean> => {
      const invalid = validateMemo(memo);
      if (invalid) {
        setNote({ text: invalid, error: true });
        return false;
      }
      setSaving(provider);
      try {
        const response = await putProviderMemo(provider, memo);
        beginLoad();
        setSettings(response);
        setNote(mutationNote("memo", response, memo.trim().length === 0));
        return true;
      } catch (error) {
        // 何も保存されなかった (503 not_stored / 400) ことを文言で区別する
        const prefix = error instanceof ApiError && error.state === "not_stored" ? "変更は保存されていません。" : "";
        setNote({ text: `${prefix}${messageFor(error)}`, error: true });
        return false;
      } finally {
        setSaving(null);
      }
    },
    [beginLoad],
  );

  const resync = useCallback(
    (provider: string): Promise<boolean> => runMutation(provider, "resync", () => resyncProviderApiKey(provider)),
    [runMutation],
  );

  return {
    settings,
    catalog,
    catalogError,
    note,
    saving,
    savingAvailability,
    reloading,
    reload,
    save,
    saveMemo,
    saveAvailability,
    remove,
    resync,
  };
}

export type ModelSettings = ReturnType<typeof useModelSettings>;
