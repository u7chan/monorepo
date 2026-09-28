import { useEffect, useState } from "react";
import { cn } from "../../lib/cn";
import { messageTimeLabel } from "../../lib/messageTime";
import {
  API_KEY_MIN_LENGTH,
  availableCountOf,
  degradedNotice,
  deleteConfirmMessage,
  groupProviders,
  MEMO_MAX_LENGTH,
  providerAuthBadge,
  providerUsage,
  resyncAvailable,
} from "../../lib/modelSettings";
import type { ModelsSettingsResponse, ProviderAuthSetting, RuntimeModelsResponse, SessionSummary } from "../../types";
import { CheckIcon, KeyIcon, RefreshIcon, TrashIcon } from "../icons";
import { ProviderBadgeTag } from "./ProviderBadgeTag";

export type ProvidersTabProps = {
  settings: ModelsSettingsResponse;
  catalog: RuntimeModelsResponse | null;
  catalogError: string | null;
  /** 変更中の provider id。null なら操作なし */
  saving: string | null;
  sessions: SessionSummary[];
  sessionsLoaded: boolean;
  compact: boolean;
  onSave: (provider: string, apiKey: string) => Promise<boolean>;
  onSaveMemo: (provider: string, memo: string) => Promise<boolean>;
  onDelete: (provider: string) => Promise<boolean>;
  onResync: (provider: string) => Promise<boolean>;
  /** キー登録後にモデルを選びに行く導線 */
  onOpenModels: () => void;
};

/**
 * 「プロバイダー」タブ。左の一覧（全 provider）と右の詳細（キー・メモ・削除・再同期）を
 * 分け、モデル一覧は「モデルを選ぶ」タブへ一本化する。平文保存の注意は詳細ペインの上部に
 * 常時出し、provider を切り替えても消えない。
 */
export function ProvidersTab({
  settings,
  catalog,
  catalogError,
  saving,
  sessions,
  sessionsLoaded,
  compact,
  onSave,
  onSaveMemo,
  onDelete,
  onResync,
  onOpenModels,
}: ProvidersTabProps) {
  const [query, setQuery] = useState("");
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const needle = query.trim().toLowerCase();
  const matched = (provider: ProviderAuthSetting) =>
    needle === "" || provider.provider.toLowerCase().includes(needle) || provider.name.toLowerCase().includes(needle);
  const groups = groupProviders(settings, catalog);
  const sections = [
    { label: `設定済み ${groups.configured.length}`, providers: groups.configured.filter(matched) },
    { label: `未設定 ${groups.unconfigured.length}`, providers: groups.unconfigured.filter(matched) },
  ];
  const visible = sections.flatMap((section) => section.providers);
  // 検索で選択中の行が消えたら先頭へ寄せる (詳細が空のままにならない)
  const active = visible.find((provider) => provider.provider === selectedProvider) ?? visible[0];
  const busy = saving !== null;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className={cn("flex min-h-0 min-w-0 flex-1", compact ? "flex-col" : "flex-row")}>
        <div
          className={cn(
            "flex min-h-0 shrink-0 flex-col",
            compact ? "max-h-[42dvh] border-b border-line" : "w-72 border-r border-line",
          )}
        >
          <div className="border-b border-line p-2">
            <input
              type="search"
              className="field min-w-0 text-xs"
              value={query}
              placeholder="provider 名 / ID で絞り込み"
              aria-label="プロバイダーを絞り込む"
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </div>
          <div className="min-h-0 flex-1 scrollbar-thin overflow-x-hidden overflow-y-auto p-2">
            {visible.length === 0 ? (
              <p className="px-1.5 py-1.5 text-2xs text-ink-muted">該当するプロバイダーがありません。</p>
            ) : (
              sections.map((section) =>
                section.providers.length === 0 ? null : (
                  <div key={section.label} className="grid gap-0.5">
                    <div className="px-1.5 pt-2 pb-0.5 text-3xs tracking-label text-ink-ghost uppercase">
                      {section.label}
                    </div>
                    {section.providers.map((provider) => {
                      const meta = providerListMeta(provider, catalog);
                      const isActive = provider.provider === active?.provider;
                      return (
                        <button
                          key={provider.provider}
                          type="button"
                          aria-current={isActive ? "true" : undefined}
                          onClick={() => setSelectedProvider(provider.provider)}
                          className={cn(
                            "grid w-full gap-0.5 rounded-lg border px-2 py-1.5 text-left transition-colors",
                            isActive ? "border-accent/40 bg-accent-wash" : "border-transparent hover:bg-hover",
                          )}
                        >
                          <span className="flex min-w-0 items-center gap-2">
                            <span className="min-w-0 flex-1 truncate text-xs text-ink">{provider.name}</span>
                            <span
                              className={cn("text-2xs whitespace-nowrap", meta.warn ? "text-warn" : "text-ink-muted")}
                            >
                              {meta.text}
                            </span>
                          </span>
                          <code className="truncate text-2xs text-ink-ghost">{provider.provider}</code>
                        </button>
                      );
                    })}
                  </div>
                ),
              )
            )}
          </div>
        </div>

        <div className="min-h-0 min-w-0 flex-1 scrollbar-thin overflow-x-hidden overflow-y-auto px-4 py-4">
          <div className="mx-auto grid max-w-3xl gap-3">
            {settings.runtimeAvailable ? null : (
              <p role="alert" className="rounded-lg border border-warn/40 bg-raised px-2.5 py-2 text-2xs text-warn">
                ランタイムが利用できないため、APIキーとメモの変更はできません。サーバーの起動ログを確認してください。
              </p>
            )}
            <SecurityNotice />
            {catalogError ? (
              <p role="alert" className="rounded-lg border border-line bg-soft px-2.5 py-2 text-2xs text-ink-muted">
                モデル一覧を取得できませんでした。{catalogError}（認証状態の表示は保っています）
              </p>
            ) : null}
            {active ? (
              <ProviderDetail
                key={active.provider}
                provider={active}
                catalog={catalog}
                runtimeAvailable={settings.runtimeAvailable}
                sessions={sessions}
                sessionsLoaded={sessionsLoaded}
                saving={saving === active.provider}
                busy={busy}
                onSave={onSave}
                onSaveMemo={onSaveMemo}
                onDelete={onDelete}
                onResync={onResync}
                onOpenModels={onOpenModels}
              />
            ) : (
              <p className="rounded-lg border border-line bg-soft px-2.5 py-2 text-xs text-ink-muted">
                プロバイダーがありません。
              </p>
            )}
          </div>
        </div>
      </div>

      <div className="shrink-0 border-t border-line bg-soft px-4 py-2.5 text-2xs leading-relaxed text-ink-muted">
        このタブの変更は、各項目の保存ボタンでその場で保存されます（横断の一括保存はありません）。
      </div>
    </div>
  );
}

/** 一覧の右端に出す短い状態。詳細のバッジより狭いので、状態の要約だけにする */
function providerListMeta(
  provider: ProviderAuthSetting,
  catalog: RuntimeModelsResponse | null,
): {
  text: string;
  warn: boolean;
} {
  if (provider.degraded === "remove") return { text: "削除が未反映", warn: true };
  if (provider.degraded === "apply") return { text: "未反映", warn: true };
  if (provider.orphan) return { text: "カタログ外", warn: true };
  const entry = catalog?.providers.find((candidate) => candidate.provider === provider.provider);
  if (!entry) return { text: "—", warn: false };
  return { text: `${availableCountOf(catalog, provider.provider)}/${entry.models.length}`, warn: false };
}

/** キーが平文で保存されることと、BFF を公開しない注意。詳細ペインの共通位置に常時出す */
function SecurityNotice() {
  return (
    <section className="grid gap-1 rounded-lg border border-warn/40 bg-raised px-2.5 py-2 text-2xs leading-relaxed text-warn">
      <p>
        登録したキーはアプリのデータベース（SQLite）へ平文で保存され、再起動後も使われます。保存したキーは再表示しません。
      </p>
      <p>メモも平文で保存され、この画面と API 応答に表示されます。キー本体は書かないでください。</p>
      <p>この GUI にはログインがありません。BFF をインターネットや LAN へ公開しないでください。</p>
      <p>キーの有効性は保存時に確認しません。「利用可能」なモデル数の増加を目安にしてください。</p>
      <p>
        APIキーは {API_KEY_MIN_LENGTH} 文字以上で入力します。環境変数（<code>.env</code>）や保存済みの{" "}
        <code>auth.json</code> の認証はそのまま使われます。
      </p>
    </section>
  );
}

function ProviderDetail({
  provider,
  catalog,
  runtimeAvailable,
  sessions,
  sessionsLoaded,
  saving,
  busy,
  onSave,
  onSaveMemo,
  onDelete,
  onResync,
  onOpenModels,
}: {
  provider: ProviderAuthSetting;
  catalog: RuntimeModelsResponse | null;
  runtimeAvailable: boolean;
  sessions: SessionSummary[];
  sessionsLoaded: boolean;
  saving: boolean;
  busy: boolean;
  onSave: (provider: string, apiKey: string) => Promise<boolean>;
  onSaveMemo: (provider: string, memo: string) => Promise<boolean>;
  onDelete: (provider: string) => Promise<boolean>;
  onResync: (provider: string) => Promise<boolean>;
  onOpenModels: () => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const savedMemo = provider.memo ?? "";
  const [memo, setMemo] = useState(savedMemo);
  const badge = providerAuthBadge(provider);
  const notice = degradedNotice(provider);
  const catalogProvider = catalog?.providers.find((entry) => entry.provider === provider.provider);
  const available = availableCountOf(catalog, provider.provider);
  const memoDirty = memo.trim() !== savedMemo;
  // キーの保存日時はこの画面で登録した (managed) provider だけに出す。null は移行前の行なので「不明」と言い切る
  const keyUpdatedLabel = !provider.managed
    ? null
    : provider.keyUpdatedAt === null
      ? "キー最終保存: 保存日不明"
      : `キー最終保存: ${messageTimeLabel(provider.keyUpdatedAt)}`;
  // 最終使用は会話の最終更新で、API 呼び出しの成功を意味しない。一覧が未取得の間は行ごと出さない
  const usage = sessionsLoaded ? providerUsage(sessions, provider.provider) : null;
  const usageLabel =
    !usage || (!provider.managed && usage.sessions === 0)
      ? null
      : usage.lastUsedAt === null
        ? "この provider の会話はありません"
        : `最終使用: ${messageTimeLabel(usage.lastUsedAt)} · この provider の会話 ${usage.sessions} 件`;

  // 保存値が変わったときだけ入力値を合わせる (同じ内容の再取得で編集中の下書きを消さない)
  useEffect(() => {
    setMemo(savedMemo);
  }, [savedMemo]);

  const submit = async () => {
    // 保存できたときだけ入力を消す (失敗したら打ち直さず再利用できるように)
    if (await onSave(provider.provider, apiKey)) setApiKey("");
  };

  const submitMemo = async () => {
    // サーバーが trim して保存するため、成功時は trim 済みの値で入力値を戻して dirty を消す
    const trimmed = memo.trim();
    if (await onSaveMemo(provider.provider, trimmed)) setMemo(trimmed);
  };

  return (
    <section className="grid gap-4">
      <div className="grid gap-2 border-b border-line pb-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h2 className="font-semibold text-base text-ink-strong">{provider.name}</h2>
          <code className="text-2xs text-ink-ghost">{provider.provider}</code>
          <ProviderBadgeTag badge={badge} />
          {catalogProvider ? (
            <span className="text-2xs whitespace-nowrap text-ink-muted">
              利用可能 {available} / カタログ {catalogProvider.models.length}
            </span>
          ) : null}
        </div>
        {keyUpdatedLabel || usageLabel ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-ink-muted">
            {keyUpdatedLabel ? <span className="whitespace-nowrap">{keyUpdatedLabel}</span> : null}
            {usageLabel ? <span className="whitespace-nowrap">{usageLabel}</span> : null}
          </div>
        ) : null}
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
            : "キーの登録はできません（メモは保存できます）。"}
        </p>
      ) : null}

      <section className="grid gap-1.5">
        <div className="text-2xs font-semibold tracking-label text-ink-faint uppercase">APIキー</div>
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
                void onDelete(provider.provider);
              }}
            >
              <TrashIcon />
              削除
            </button>
          ) : null}
          {resyncAvailable(provider) ? (
            <button
              type="button"
              className="btn-quiet"
              disabled={busy}
              onClick={() => void onResync(provider.provider)}
            >
              <RefreshIcon />
              {saving ? "再同期中" : "再同期"}
            </button>
          ) : null}
        </div>
        <p className="text-2xs leading-relaxed text-ink-muted">
          キーを保存して「モデルを選ぶ」タブに戻ると、利用可能なモデルが増えることがあります。
        </p>
      </section>

      <section className="grid gap-1.5">
        {/* キー入力とは別の form にして、Enter がキーの保存を走らせないようにする */}
        <form
          className="grid gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            void submitMemo();
          }}
        >
          <label className="grid gap-1 text-2xs text-ink-soft">
            メモ（キー本体は書かないでください）
            <textarea
              className="field min-h-11 min-w-0 text-xs"
              rows={2}
              maxLength={MEMO_MAX_LENGTH}
              value={memo}
              placeholder="例: 個人アカウントの本番キー（2026-01 発行）"
              aria-label={`${provider.name} のメモ`}
              disabled={!runtimeAvailable}
              onChange={(event) => setMemo(event.currentTarget.value)}
            />
          </label>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-2xs text-warn">{memoDirty ? "メモに未保存の変更があります" : ""}</span>
            <button type="submit" className="btn-primary" disabled={!memoDirty || !runtimeAvailable || busy}>
              <CheckIcon />
              メモを保存
            </button>
          </div>
        </form>
      </section>

      <section className="grid gap-1.5 border-t border-line pt-3">
        <div className="flex flex-wrap items-center gap-2 text-2xs text-ink-muted">
          <KeyIcon />
          モデルの選択と既定モデルは「モデルを選ぶ」タブで設定します。
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn-quiet" onClick={onOpenModels}>
            「モデルを選ぶ」タブを開く
          </button>
        </div>
      </section>
    </section>
  );
}
