import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelOAuthLogin,
  deleteCustomProvider,
  deleteProviderApiKey,
  getModelsSettings,
  getRuntimeModels,
  isNotStoredError,
  logoutOAuthProvider,
  postCustomProvider,
  putCustomProvider,
  putModelAvailability,
  putProviderApiKey,
  putProviderMemo,
  refreshModelCatalog,
  resyncProviderApiKey,
  startOAuthLogin,
  submitOAuthLoginCode,
} from "../api";
import {
  CUSTOM_PROVIDER_CREATED_NOTE,
  CUSTOM_PROVIDER_DELETED_NOTE,
  CUSTOM_PROVIDER_UPDATED_NOTE,
} from "../lib/customProviders";
import {
  MODEL_SETTINGS_NOTE,
  mutationNote,
  OAUTH_LOGIN_CANCEL_NOTE,
  OAUTH_LOGIN_CODE_NOTE,
  OAUTH_LOGIN_DONE_NOTE,
  OAUTH_LOGIN_POLL_MS,
  OAUTH_LOGIN_SIGNOUT_NOTE,
  OAUTH_LOGIN_STARTED_NOTE,
  refreshModelsForAuthChange,
  runModelCatalogRefresh,
  oauthLoginNote,
  providerLoginState,
  validateApiKey,
  validateMemo,
  type MutationAction,
} from "../lib/modelSettings";
import { messageFor, mutationErrorNote } from "../lib/settingsResource";
import type {
  CreateCustomProviderBody,
  Health,
  ModelMutationResponse,
  ModelsSettingsResponse,
  OAuthLoginState,
  RuntimeModelsResponse,
  UpdateCustomProviderBody,
  UpdateModelAvailabilityBody,
} from "../types";
import { createLoadingTracker, createRequestGate } from "./requestGate";

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
  const [refreshing, setRefreshing] = useState(false);
  const [beginLoad] = useState(createRequestGate);
  // 破棄された取得でも進行中を解除するため、適用の可否とは別に追う
  const [reloadTracker] = useState(() => createLoadingTracker(setReloading));
  const [refreshTracker] = useState(() => createLoadingTracker(setRefreshing));
  // provider ごとの直近のサインイン状態。進行中 → 終端の遷移で health とカタログを 1 回だけ取り直す
  const loginStatuses = useRef<Record<string, string>>({});

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

  /**
   * サインインの状態を取り込む。進行中 → 終端に変わった provider の結末を返す (null = 変化なし)。
   * 終端が成功ならモデル候補を取り直し、失敗 / 中断は詳細ペインの表示に任せる。
   */
  const trackLoginStatuses = useCallback((next: ModelsSettingsResponse): "succeeded" | "other" | null => {
    const previous = loginStatuses.current;
    const current: Record<string, string> = {};
    let finished: "succeeded" | "other" | null = null;
    for (const provider of next.providers) {
      const status = provider.login?.status;
      if (!status) continue;
      current[provider.provider] = status;
      if (previous[provider.provider] === "running" && status !== "running") {
        finished = status === "succeeded" ? "succeeded" : "other";
      }
    }
    loginStatuses.current = current;
    return finished;
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** 進行中のサインインの完了を拾う。サーバー側で進むため、終端まで GET を読み直す */
  const loginRunning = settings?.providers.some((provider) => provider.login?.status === "running") ?? false;
  useEffect(() => {
    if (!loginRunning) return;
    let stopped = false;
    const timer = window.setInterval(() => {
      void (async () => {
        const canApply = beginLoad();
        try {
          const next = await getModelsSettings();
          if (stopped || !canApply()) return;
          const finished = trackLoginStatuses(next);
          setSettings(next);
          if (finished) {
            setNote({
              text: finished === "succeeded" ? OAUTH_LOGIN_DONE_NOTE : MODEL_SETTINGS_NOTE,
              error: false,
            });
          }
          if (finished === "succeeded") {
            await refreshModelsForAuthChange({ canApply, refreshHealth: onRefreshHealth, loadCatalog });
          }
        } catch {
          // ポーリングの失敗は注記を変えない (次の周期でやり直す)
        }
      })();
    }, OAUTH_LOGIN_POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [beginLoad, loadCatalog, loginRunning, onRefreshHealth, trackLoginStatuses]);

  /** 変更系の応答を適用し、health とカタログを取り直す (composer のモデル候補を追随させる) */
  const applyMutation = useCallback(
    async (action: MutationAction, response: ModelMutationResponse) => {
      // 進行中の読み込みの応答で、いま適用した応答を上書きさせない
      const canApply = beginLoad();
      setSettings(response);
      setNote(mutationNote(action, response));
      await refreshModelsForAuthChange({ canApply, refreshHealth: onRefreshHealth, loadCatalog });
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
        setNote({ text: mutationErrorNote(error, isNotStoredError(error)), error: true });
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
        setNote({ text: mutationErrorNote(error, isNotStoredError(error)), error: true });
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
        setNote({ text: mutationErrorNote(error, isNotStoredError(error)), error: true });
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

  /**
   * カスタムプロバイダーの変更。応答は GET と同じ形なのでそのまま次の状態にし、認証が変わるため
   * health とカタログを取り直す（「モデルを選ぶ」タブの候補を追随させる）。
   */
  const runCustomMutation = useCallback(
    async (provider: string, note: string, run: () => Promise<ModelMutationResponse>): Promise<boolean> => {
      setSaving(provider);
      try {
        const canApply = beginLoad();
        const response = await run();
        setSettings(response);
        setNote({ text: note, error: false });
        await refreshModelsForAuthChange({ canApply, refreshHealth: onRefreshHealth, loadCatalog });
        return true;
      } catch (error) {
        setNote({ text: mutationErrorNote(error, isNotStoredError(error)), error: true });
        return false;
      } finally {
        setSaving(null);
      }
    },
    [beginLoad, loadCatalog, onRefreshHealth],
  );

  const createCustom = useCallback(
    (input: CreateCustomProviderBody): Promise<boolean> =>
      runCustomMutation(input.id, CUSTOM_PROVIDER_CREATED_NOTE, () => postCustomProvider(input)),
    [runCustomMutation],
  );

  const updateCustom = useCallback(
    (provider: string, input: UpdateCustomProviderBody): Promise<boolean> =>
      runCustomMutation(provider, CUSTOM_PROVIDER_UPDATED_NOTE, () => putCustomProvider(provider, input)),
    [runCustomMutation],
  );

  const removeCustom = useCallback(
    (provider: string): Promise<boolean> =>
      runCustomMutation(provider, CUSTOM_PROVIDER_DELETED_NOTE, () => deleteCustomProvider(provider)),
    [runCustomMutation],
  );

  /**
   * OAuth サインインの操作。応答は GET と同じ形なので、そのまま次の state にし、進行中 → 終端の
   * 遷移ではモデル候補も取り直す。進行中の完了はログイン中だけ回るポーリングが拾う。
   */
  const runOAuth = useCallback(
    async (
      provider: string,
      run: () => Promise<ModelsSettingsResponse>,
      options: {
        /** 操作の直後の注記。引数は応答のサインイン状態 (null = 進行中の状態なし) */
        note: (state: OAuthLoginState | null) => { text: string; error: boolean };
        /** 認証が変わる操作 (サインアウト) で health とカタログを取り直すか */
        refreshModels?: boolean;
      },
    ): Promise<boolean> => {
      setSaving(provider);
      try {
        // 進行中の読み込みの応答で、いま適用した応答を上書きさせない
        const canApply = beginLoad();
        const next = await run();
        const finished = trackLoginStatuses(next);
        setSettings(next);
        setNote(options.note(providerLoginState(next, provider)));
        if (finished === "succeeded" || options.refreshModels) {
          await refreshModelsForAuthChange({ canApply, refreshHealth: onRefreshHealth, loadCatalog });
        }
        return true;
      } catch (error) {
        setNote({ text: messageFor(error), error: true });
        return false;
      } finally {
        setSaving(null);
      }
    },
    [beginLoad, loadCatalog, onRefreshHealth, trackLoginStatuses],
  );

  const startLogin = useCallback(
    (provider: string) =>
      runOAuth(provider, () => startOAuthLogin(provider), {
        note: (state) => oauthLoginNote(state, OAUTH_LOGIN_STARTED_NOTE),
      }),
    [runOAuth],
  );

  const submitLoginCode = useCallback(
    (provider: string, code: string) =>
      runOAuth(provider, () => submitOAuthLoginCode(provider, code), {
        note: (state) => oauthLoginNote(state, OAUTH_LOGIN_CODE_NOTE),
      }),
    [runOAuth],
  );

  /** 中断と結果表示の消去は同じ入口。中断できたときだけ中断の注記を出す */
  const cancelLogin = useCallback(
    (provider: string) =>
      runOAuth(provider, () => cancelOAuthLogin(provider), {
        note: (state) =>
          state?.status === "cancelled"
            ? { text: OAUTH_LOGIN_CANCEL_NOTE, error: false }
            : { text: MODEL_SETTINGS_NOTE, error: false },
      }),
    [runOAuth],
  );

  const signOut = useCallback(
    (provider: string) =>
      runOAuth(provider, () => logoutOAuthProvider(provider), {
        note: () => ({ text: OAUTH_LOGIN_SIGNOUT_NOTE, error: false }),
        refreshModels: true,
      }),
    [runOAuth],
  );

  /**
   * カタログの手動更新。応答は `GET /api/runtime/models` と同じ形なのでその場で一覧を差し替え、
   * 直後の `loadCatalog()` は呼ばない (二重取得と、直後の GET 失敗で適用済みの一覧を消す事故を避ける)。
   * health の再取得は変更系と同じ順序 (`beginLoad` → 適用 → `onRefreshHealth`) でだけ揃える
   * (refresh の応答には `state` が無いため `applyMutation` は使えない)。
   */
  const refreshCatalog = useCallback(async (): Promise<void> => {
    const finishRefresh = refreshTracker.begin();
    try {
      const result = await runModelCatalogRefresh(refreshModelCatalog);
      // 進行中の読み込みの応答で、いま適用した結果を上書きさせない
      const canApply = beginLoad();
      // 失敗 (503 を含む) は注記だけで、一覧と catalogError は手元のままにする
      if (result.applied) {
        setCatalog(result.catalog);
        setCatalogError(null);
      }
      setNote(result.note);
      await onRefreshHealth(canApply);
    } finally {
      finishRefresh();
    }
  }, [beginLoad, onRefreshHealth, refreshTracker]);

  return {
    settings,
    catalog,
    catalogError,
    note,
    saving,
    savingAvailability,
    reloading,
    refreshing,
    reload,
    refreshCatalog,
    save,
    saveMemo,
    saveAvailability,
    remove,
    resync,
    createCustom,
    updateCustom,
    removeCustom,
    startLogin,
    submitLoginCode,
    cancelLogin,
    signOut,
  };
}

export type ModelSettings = ReturnType<typeof useModelSettings>;
