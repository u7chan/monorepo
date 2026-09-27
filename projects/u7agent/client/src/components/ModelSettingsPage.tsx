import { useEffect, useState } from "react";
import { useModelSettings, type ModelSettings } from "../hooks/useModelSettings";
import { cn } from "../lib/cn";
import {
  API_KEY_MIN_LENGTH,
  AVAILABILITY_SAVE_INITIAL,
  allowedModelsOutsideCatalog,
  availabilityCounts,
  availabilityDefaultChoices,
  availabilityDraftFromSettings,
  availabilityDraftWithAllModels,
  availabilityGroups,
  availabilityNotice,
  availabilitySaveConfirmMessage,
  availabilitySaveOnSubmit,
  availableCountOf,
  degradedNotice,
  deleteConfirmMessage,
  groupProviders,
  isModelAllowed,
  normalizeAllowedModels,
  providerAuthBadge,
  resyncAvailable,
  type AvailabilityDraft,
  type AvailabilitySaveState,
  type ProviderBadgeTone,
} from "../lib/modelSettings";
import type {
  Health,
  ModelsSettingsResponse,
  ProviderAuthSetting,
  RuntimeCatalogModel,
  RuntimeModelsResponse,
  UpdateModelAvailabilityBody,
} from "../types";
import { CheckIcon, KeyIcon, RefreshIcon, TrashIcon } from "./icons";
import { SettingsPageLayout, type SettingsPageProps } from "./SettingsPageLayout";

export type ModelSettingsPageProps = SettingsPageProps & {
  /** キーの変更後に composer のモデル候補を更新する (画面を開いている間だけ使う) */
  onRefreshHealth: (isCurrent?: () => boolean) => Promise<Health | null>;
};

/**
 * 設定 → モデル。利用可能なモデル（許可リスト）とプロバイダー認証を編集する。
 * hook はこの画面が持つ (カタログ全件を起動のたびに読まない。開いたときだけ取得する)。
 */
export function ModelSettingsPage({ onRefreshHealth, compact, onBack, onOpenNav }: ModelSettingsPageProps) {
  return (
    <ModelSettingsView
      modelSettings={useModelSettings({ onRefreshHealth })}
      compact={compact}
      onBack={onBack}
      onOpenNav={onOpenNav}
    />
  );
}

/** 表示だけを持つ部分。取得の成否は modelSettings が持ち、ここは描画に徹する */
export function ModelSettingsView({
  modelSettings,
  compact = false,
  onBack,
  onOpenNav,
}: SettingsPageProps & { modelSettings: ModelSettings }) {
  const {
    settings,
    catalog,
    catalogError,
    note,
    saving,
    savingAvailability,
    reloading,
    reload,
    save,
    saveAvailability,
    remove,
    resync,
  } = modelSettings;
  const [revealUnconfigured, setRevealUnconfigured] = useState(false);
  const groups = settings ? groupProviders(settings, catalog) : null;

  return (
    <SettingsPageLayout
      eyebrow="MODELS"
      title="モデル"
      caption="利用可能なモデルと、プロバイダーごとのAPIキーを設定します。保存した内容は再起動後も使われます。"
      actions={
        <button type="button" className="btn-quiet" onClick={() => void reload()} disabled={reloading}>
          <RefreshIcon />
          再読み込み
        </button>
      }
      note={note}
      compact={compact}
      onOpenNav={onOpenNav}
      onBack={onBack}
    >
      <div className="min-h-0 min-w-0 scrollbar-thin overflow-x-hidden overflow-y-auto px-4 py-4">
        <div className="mx-auto grid max-w-3xl gap-3">
          {settings ? (
            <AvailabilitySection
              settings={settings}
              catalog={catalog}
              catalogError={catalogError}
              saving={savingAvailability}
              onSave={saveAvailability}
            />
          ) : null}

          <section className="grid gap-2 rounded-lg border border-line bg-soft p-3">
            <h3 className="text-2xs font-semibold tracking-label text-ink-faint uppercase">この画面でできること</h3>
            <ul className="grid gap-1 text-2xs leading-relaxed text-ink-soft">
              <li>登録したキーはアプリのデータベース（SQLite）へ平文で保存され、再起動後も使われます。</li>
              <li>保存したキーは再表示しません。変更するときは同じ provider へ上書き登録してください。</li>
              <li>この GUI にはログインがありません。BFF をインターネットや LAN へ公開しないでください。</li>
              <li>キーの有効性は保存時に確認しません。「利用可能」なモデル数の増加を目安にしてください。</li>
              <li>
                APIキーは {API_KEY_MIN_LENGTH} 文字以上で入力します。環境変数（<code>.env</code>）や保存済みの{" "}
                <code>auth.json</code> の認証はそのまま使われます。
              </li>
            </ul>
          </section>

          {settings === null ? (
            <div className="grid justify-items-start gap-2 rounded-lg border border-line bg-soft p-3 text-xs text-ink-muted">
              {note.error ? (
                <>
                  <p role="alert">プロバイダーの認証状態を読み込めませんでした。</p>
                  <button type="button" className="btn-quiet" onClick={() => void reload()}>
                    <RefreshIcon />
                    再読み込み
                  </button>
                </>
              ) : (
                <p role="status">プロバイダーの認証状態を読み込んでいます。</p>
              )}
            </div>
          ) : (
            <>
              {settings.runtimeAvailable ? null : (
                <p role="alert" className="rounded-lg border border-warn/40 bg-raised px-2.5 py-2 text-2xs text-warn">
                  ランタイムが利用できないため、APIキーの登録・削除はできません。サーバーの起動ログを確認してください。
                </p>
              )}

              <section className="grid gap-2">
                {groups && groups.configured.length > 0 ? (
                  groups.configured.map((provider) => (
                    <ProviderCard
                      key={provider.provider}
                      provider={provider}
                      catalog={catalog}
                      saving={saving === provider.provider}
                      busy={saving !== null}
                      onSave={(apiKey) => save(provider.provider, apiKey)}
                      onDelete={() => remove(provider.provider)}
                      onResync={() => resync(provider.provider)}
                    />
                  ))
                ) : (
                  <p className="rounded-lg border border-line bg-soft px-2.5 py-2 text-xs text-ink-muted">
                    設定済みのプロバイダーはありません。
                  </p>
                )}

                {groups && groups.unconfigured.length > 0 ? (
                  <details
                    className="overflow-hidden rounded-lg border border-line bg-soft"
                    open={revealUnconfigured}
                    onToggle={(event) => setRevealUnconfigured(event.currentTarget.open)}
                  >
                    <summary className="disclosure-summary block cursor-pointer px-2.5 py-2 text-xs text-ink-soft transition-colors outline-none hover:bg-raised/60 focus-visible:ring-1 focus-visible:ring-focus focus-visible:ring-inset">
                      未設定のプロバイダーを表示 ({groups.unconfigured.length})
                    </summary>
                    <div className="grid gap-2 border-t border-line p-2">
                      {groups.unconfigured.map((provider) => (
                        <ProviderCard
                          key={provider.provider}
                          provider={provider}
                          catalog={catalog}
                          saving={saving === provider.provider}
                          busy={saving !== null}
                          onSave={(apiKey) => save(provider.provider, apiKey)}
                          onDelete={() => remove(provider.provider)}
                          onResync={() => resync(provider.provider)}
                        />
                      ))}
                    </div>
                  </details>
                ) : null}
              </section>

              {catalogError ? (
                <p role="alert" className="rounded-lg border border-line bg-soft px-2.5 py-2 text-2xs text-ink-muted">
                  モデル一覧を取得できませんでした。{catalogError}（認証状態の表示は保っています）
                </p>
              ) : null}
            </>
          )}
        </div>
      </div>
    </SettingsPageLayout>
  );
}

/**
 * 「利用可能なモデル」セクション。チェックと既定モデルを下書きとして持ち、[保存] で一括適用する。
 * 許可されているかの正は settings.allowedModels だけで、カタログは候補とモデル一覧にしか使わない。
 */
function AvailabilitySection({
  settings,
  catalog,
  catalogError,
  saving,
  onSave,
}: {
  settings: ModelsSettingsResponse;
  catalog: RuntimeModelsResponse | null;
  catalogError: string | null;
  saving: boolean;
  onSave: (input: UpdateModelAvailabilityBody) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<AvailabilityDraft>(() => availabilityDraftFromSettings(settings));
  const [saveState, setSaveState] = useState<AvailabilitySaveState>(AVAILABILITY_SAVE_INITIAL);
  // 読み込み・保存で保存値が入れ替わったときだけ下書きを戻す (取得失敗では settings が変わらない)
  useEffect(() => {
    setDraft(availabilityDraftFromSettings(settings));
  }, [settings]);
  // 下書きが変わったら確認をやり直す (前の内容への同意を、違う内容の保存へ流用しない)
  useEffect(() => {
    setSaveState(AVAILABILITY_SAVE_INITIAL);
  }, [draft]);

  // 編集不可は取得失敗 (catalogError) だけで判定する。catalog === null は初期ロード中も真になるため、
  // 読み込み中を「編集できません」と混同しない (保存も読み込みが終わるまで押せない)
  const blocked = catalogError !== null;
  const loading = catalog === null;
  const counts = availabilityCounts(draft, catalog);
  const notice = availabilityNotice(draft, catalog);
  const confirmMessage = availabilitySaveConfirmMessage(saveState, notice);
  const groups = availabilityGroups(draft, catalog);
  const choices = availabilityDefaultChoices(draft, catalog);
  const orphans = allowedModelsOutsideCatalog(draft.allowed, catalog);

  const setUnrestricted = (unrestricted: boolean) => {
    setDraft((current) =>
      // 制限なしから選択へ戻すときは全件を選んだ状態から始める (全部外すと「制限なし」へ寄るため)
      unrestricted || current.allowed.length > 0
        ? { ...current, unrestricted }
        : { ...current, unrestricted, allowed: availabilityDraftWithAllModels(catalog) },
    );
  };

  const toggleModel = (key: string) => {
    setDraft((current) => {
      const allowed = isModelAllowed(current.allowed, key)
        ? current.allowed.filter((entry) => entry !== key)
        : [...current.allowed, key];
      // 外したモデルが既定のまま残ると保存が 400 になるため、同時に未設定へ戻す
      const defaultModel = current.defaultModel === key ? null : current.defaultModel;
      return { ...current, allowed, defaultModel };
    });
  };

  const submit = async () => {
    // 確認の文言は純関数が組み立てる。send が false の押下では PUT を送らない
    const next = availabilitySaveOnSubmit(saveState, notice);
    setSaveState(next.state);
    if (!next.send) return;
    await onSave({
      allowedModels: draft.unrestricted ? null : normalizeAllowedModels(draft.allowed),
      defaultModel: draft.defaultModel,
    });
  };

  return (
    <section className="grid gap-2 rounded-lg border border-line bg-soft p-3">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <h3 className="text-2xs font-semibold tracking-label text-ink-faint uppercase">利用可能なモデル</h3>
        <div className="flex flex-wrap items-center gap-2">
          {counts ? (
            <span className="text-2xs whitespace-nowrap text-ink-muted">
              利用可能 {counts.available} / 許可 {counts.allowed} / カタログ {counts.catalog}
            </span>
          ) : null}
          <button
            type="button"
            className="btn-primary"
            disabled={saving || loading || blocked || confirmMessage !== undefined}
            onClick={() => void submit()}
          >
            <CheckIcon />
            {loading ? "読み込み中" : saving ? "保存中" : "保存"}
          </button>
        </div>
      </div>
      <p className="text-2xs leading-relaxed text-ink-soft">
        新しい会話で使えるモデルを選びます。保存した内容は新しい会話のモデル候補とアプリ既定モデルに効き、開いている会話のモデルは切り替えません。未ロードの会話は、次に開いたときに候補外ならアプリ既定へフォールバックします。
      </p>

      {confirmMessage ? (
        <div className="grid gap-2 rounded-md border border-warn/40 bg-raised px-2.5 py-2">
          <p role="alert" className="text-2xs leading-relaxed text-warn">
            {confirmMessage}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn-primary" disabled={saving} onClick={() => void submit()}>
              <CheckIcon />
              保存する
            </button>
            <button
              type="button"
              className="btn-quiet"
              disabled={saving}
              onClick={() => setSaveState(AVAILABILITY_SAVE_INITIAL)}
            >
              キャンセル
            </button>
          </div>
        </div>
      ) : null}

      {blocked ? (
        <p role="alert" className="rounded-md border border-warn/40 bg-raised px-2.5 py-2 text-2xs text-warn">
          モデル一覧を取得できないため、利用可能なモデルは編集できません。（{catalogError}）
        </p>
      ) : loading ? (
        <p role="status" className="text-2xs text-ink-muted">
          モデル一覧を読み込んでいます。
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <label className="flex items-center gap-1.5 text-2xs text-ink-soft">
              <input
                type="checkbox"
                checked={draft.unrestricted}
                disabled={saving}
                onChange={(event) => setUnrestricted(event.currentTarget.checked)}
              />
              制限なし（全モデル）
            </label>
            <span className="text-2xs text-ink-muted">
              {draft.unrestricted ? "すべてのモデルを候補にします。" : "チェックしたモデルだけが候補になります。"}
            </span>
          </div>

          <label className="grid gap-1 text-2xs text-ink-soft">
            アプリ既定モデル
            <select
              className="field text-xs"
              value={draft.defaultModel ?? ""}
              disabled={saving}
              onChange={(event) => {
                // state updater は遅延評価されるため、event は setter の外で読む
                const value = event.currentTarget.value || null;
                setDraft((current) => ({ ...current, defaultModel: value }));
              }}
            >
              <option value="">未設定（利用可能なモデルの先頭を使う）</option>
              {choices.map((choice) => (
                <option key={choice.key} value={choice.key}>
                  {choice.label}
                </option>
              ))}
            </select>
          </label>
          {notice.warning ? (
            <p role="alert" className="rounded-md border border-warn/40 bg-raised px-2.5 py-1.5 text-2xs text-warn">
              {notice.warning}
            </p>
          ) : null}

          {orphans.length > 0 ? (
            <div className="grid gap-1 rounded-md border border-warn/40 bg-raised px-2.5 py-2">
              <p className="text-2xs text-warn">
                現在のカタログに無いモデルが保存されています。削除するまで保存できません。
              </p>
              {orphans.map((key) => (
                <div key={key} className="flex flex-wrap items-center justify-between gap-2">
                  <code className="text-2xs break-all text-ink">{key}</code>
                  <button type="button" className="btn-quiet" disabled={saving} onClick={() => toggleModel(key)}>
                    <TrashIcon />
                    削除
                  </button>
                </div>
              ))}
            </div>
          ) : null}

          <div className="grid gap-2">
            {groups.map((group) => (
              <details key={group.provider} className="overflow-hidden rounded-lg border border-line bg-raised">
                <summary className="disclosure-summary block cursor-pointer px-2.5 py-2 text-xs text-ink-soft transition-colors outline-none hover:bg-soft/40 focus-visible:ring-1 focus-visible:ring-focus focus-visible:ring-inset">
                  <code className="text-2xs break-all text-ink">{group.provider}</code>{" "}
                  <span className="text-2xs text-ink-muted">
                    {group.rows.length} モデル · 選択 {group.rows.filter((row) => row.checked).length}
                    {group.authConfigured ? "" : " · 未認証"}
                  </span>
                </summary>
                <div className="grid gap-1 border-t border-line p-2">
                  {group.rows.length === 0 ? (
                    <p className="text-2xs text-ink-muted">この provider のカタログモデルはありません。</p>
                  ) : (
                    group.rows.map((row) => (
                      <label
                        key={row.key}
                        className="flex cursor-pointer items-center justify-between gap-x-3 gap-y-1 rounded px-1 py-0.5 hover:bg-soft/40"
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <input
                            type="checkbox"
                            checked={row.checked}
                            disabled={saving || draft.unrestricted}
                            onChange={() => toggleModel(row.key)}
                          />
                          <span className="min-w-0 truncate text-2xs text-ink">{row.name}</span>
                          <code className="text-2xs break-all text-ink-ghost">{row.key}</code>
                        </span>
                        <span
                          className={cn("text-2xs whitespace-nowrap", row.available ? "text-ok" : "text-ink-faint")}
                        >
                          {row.available ? "利用可能" : "利用不可"}
                        </span>
                      </label>
                    ))
                  )}
                </div>
              </details>
            ))}
          </div>
        </>
      )}

      {settings.ignoredEnvironmentVariables.length > 0 ? (
        <p className="border-t border-line pt-2 text-2xs leading-relaxed text-warn">
          環境変数{" "}
          {settings.ignoredEnvironmentVariables.map((name) => (
            <code key={name} className="mr-1">
              {name}
            </code>
          ))}
          は無視されます。設定 → モデル の内容だけが使われるため、デプロイ設定からは削除してください。
        </p>
      ) : null}
    </section>
  );
}

const BADGE_TONE: Record<ProviderBadgeTone, string> = {
  ok: "border-ok/40 text-ok",
  muted: "border-line text-ink-muted",
  warn: "border-warn/40 text-warn",
};

function ProviderCard({
  provider,
  catalog,
  saving,
  busy,
  onSave,
  onDelete,
  onResync,
}: {
  provider: ProviderAuthSetting;
  catalog: RuntimeModelsResponse | null;
  saving: boolean;
  busy: boolean;
  onSave: (apiKey: string) => Promise<boolean>;
  onDelete: () => Promise<boolean>;
  onResync: () => Promise<boolean>;
}) {
  const [apiKey, setApiKey] = useState("");
  const badge = providerAuthBadge(provider);
  const notice = degradedNotice(provider);
  const catalogProvider = catalog?.providers.find((entry) => entry.provider === provider.provider);
  const available = availableCountOf(catalog, provider.provider);

  const submit = async () => {
    // 保存できたときだけ入力を消す (失敗したら打ち直さず再利用できるように)
    if (await onSave(apiKey)) setApiKey("");
  };

  return (
    <section className="grid gap-2 rounded-lg border border-line bg-soft p-3">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <h4 className="text-xs font-semibold text-ink">{provider.name}</h4>
          <code className="text-2xs break-all text-ink-ghost">{provider.provider}</code>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn("rounded border px-1.5 py-0.5 text-2xs", BADGE_TONE[badge.tone])}>
            <KeyIcon /> {badge.label}
          </span>
          {catalogProvider ? (
            <span className="text-2xs whitespace-nowrap text-ink-muted">
              利用可能 {available} / カタログ {catalogProvider.models.length}
            </span>
          ) : null}
        </div>
      </div>

      {notice ? (
        <p
          role="alert"
          className="rounded-md border border-warn/40 bg-raised px-2.5 py-1.5 text-2xs leading-relaxed text-warn"
        >
          {notice}
        </p>
      ) : null}
      {provider.orphan ? (
        <p className="text-2xs leading-relaxed text-ink-muted">
          現在のカタログに無い provider です。
          {provider.managed
            ? "保存済みのキーは削除できます（カタログに戻るまで再登録はできません）。"
            : "この画面からの登録はできません。"}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {provider.canSetApiKey ? (
          <form
            className="flex min-w-0 flex-1 flex-wrap items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <input
              className="field min-w-0 flex-1 text-xs"
              type="password"
              value={apiKey}
              placeholder={provider.managed ? "新しいAPIキー（上書き）" : "APIキー"}
              aria-label={`${provider.name} のAPIキー`}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setApiKey(event.currentTarget.value)}
            />
            <button type="submit" className="btn-primary" disabled={busy || apiKey.length === 0}>
              <CheckIcon />
              {provider.managed ? "上書き保存" : "保存"}
            </button>
          </form>
        ) : (
          <p className="min-w-0 flex-1 text-2xs text-ink-ghost">
            この provider のキーは環境変数や認証ファイルで設定します（この画面からは登録できません）。
          </p>
        )}
        {provider.managed ? (
          <button
            type="button"
            className="btn-quiet"
            disabled={busy}
            onClick={() => {
              if (!window.confirm(deleteConfirmMessage(provider.name))) return;
              void onDelete();
            }}
          >
            <TrashIcon />
            削除
          </button>
        ) : null}
        {resyncAvailable(provider) ? (
          <button type="button" className="btn-quiet" disabled={busy} onClick={() => void onResync()}>
            <RefreshIcon />
            {saving ? "再同期中" : "再同期"}
          </button>
        ) : null}
      </div>

      {catalogProvider ? (
        <details className="rounded-md border border-line bg-raised">
          <summary className="disclosure-summary block cursor-pointer px-2.5 py-1.5 text-2xs text-ink-soft transition-colors outline-none hover:bg-soft/40 focus-visible:ring-1 focus-visible:ring-focus focus-visible:ring-inset">
            モデル一覧を表示
          </summary>
          <div className="grid gap-2 border-t border-line px-2.5 py-2">
            {catalogProvider.models.length === 0 ? (
              <p className="text-2xs text-ink-muted">このプロバイダーのカタログモデルはありません。</p>
            ) : (
              <ModelTable models={catalogProvider.models} />
            )}
          </div>
        </details>
      ) : null}
    </section>
  );
}

const STATUS_MARK = {
  ok: "text-ok",
  muted: "text-ink-faint",
} as const;

/** モデル名と ID を別の列に分ける。同じ行に続けて出すと、名前と識別子の境目が読めない */
function ModelTable({ models }: { models: RuntimeCatalogModel[] }) {
  return (
    <table className="w-full table-fixed border-collapse text-2xs">
      <thead>
        <tr className="text-3xs text-ink-muted">
          <th scope="col" className="w-2/5 pr-2 pb-1 text-left font-medium">
            モデル
          </th>
          <th scope="col" className="w-2/5 pr-2 pb-1 text-left font-medium">
            ID
          </th>
          <th scope="col" className="w-1/5 pb-1 text-left font-medium">
            利用可能
          </th>
        </tr>
      </thead>
      <tbody>
        {models.map((model) => (
          <tr key={model.id} className="border-t border-line/60 align-top">
            <td className="py-1 pr-2 break-words text-ink">{model.name}</td>
            <td className="py-1 pr-2 font-mono break-all text-ink-muted">{model.id}</td>
            <td className={cn("py-1", STATUS_MARK[model.available ? "ok" : "muted"])}>
              {model.available ? "はい" : "いいえ"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
