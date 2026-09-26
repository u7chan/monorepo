import { useState } from "react";
import { useModelSettings, type ModelSettings } from "../hooks/useModelSettings";
import { cn } from "../lib/cn";
import {
  API_KEY_MIN_LENGTH,
  availableCountOf,
  degradedNotice,
  deleteConfirmMessage,
  groupProviders,
  providerAuthBadge,
  resyncAvailable,
  type ProviderBadgeTone,
} from "../lib/modelSettings";
import type { Health, ProviderAuthSetting, RuntimeCatalogModel, RuntimeModelsResponse } from "../types";
import { CheckIcon, KeyIcon, RefreshIcon, TrashIcon } from "./icons";
import { SettingsPageLayout, type SettingsPageProps } from "./SettingsPageLayout";

export type ModelSettingsPageProps = SettingsPageProps & {
  /** キーの変更後に composer のモデル候補を更新する (画面を開いている間だけ使う) */
  onRefreshHealth: (isCurrent?: () => boolean) => Promise<Health | null>;
};

/**
 * 設定 → モデル。表示専用のランタイム画面と分け、プロバイダー認証だけをここで編集する。
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
  const { settings, catalog, catalogError, note, saving, reloading, reload, save, remove, resync } = modelSettings;
  const [revealUnconfigured, setRevealUnconfigured] = useState(false);
  const groups = settings ? groupProviders(settings, catalog) : null;

  return (
    <SettingsPageLayout
      eyebrow="MODELS"
      title="モデル"
      caption="プロバイダーごとのAPIキーを登録・削除します。登録したキーはモデル候補へ反映されます。"
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
            {settings ? (
              <p className="border-t border-line pt-2 text-2xs text-ink-muted">
                アプリ既定モデル: <code>{settings.defaultModel ?? "指定なし"}</code>
                {settings.whitelistConfigured ? (
                  <>
                    {" "}
                    · 選択できるモデルは <code>PI_MODELS</code> で制限されています（設定 → ランタイムで診断）。
                  </>
                ) : null}
              </p>
            ) : null}
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
