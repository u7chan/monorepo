import { useEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import {
  CUSTOM_PROVIDER_ADD_LABEL,
  CUSTOM_PROVIDER_MEMORY_BADGE,
  CUSTOM_PROVIDER_NOTES,
  CUSTOM_PROVIDER_SECTION_TITLE,
} from "../../lib/customProviders";
import { messageTimeLabel } from "../../lib/messageTime";
import {
  API_KEY_MIN_LENGTH,
  availableCountOf,
  degradedNotice,
  groupProviders,
  hiddenStoredOAuthNotice,
  providerAuthBadge,
  providerCredentialTabs,
  providerUsage,
  type CredentialTab,
  type ProviderDraft,
} from "../../lib/modelSettings";
import type {
  CreateCustomProviderBody,
  ModelsSettingsResponse,
  ProviderAuthSetting,
  RuntimeModelsResponse,
  SessionSummary,
  UpdateCustomProviderBody,
} from "../../types";
import { CollapsibleNotice } from "../CollapsibleNotice";
import { DisclosureChevronIcon, KeyIcon } from "../icons";
import { ProviderIcon } from "../ProviderIcon";
import { ApiKeySection } from "./ApiKeySection";
import { CredentialTabs } from "./CredentialTabs";
import { CustomProviderForm } from "./CustomProviderForm";
import { MetaChip } from "./MetaChip";
import { OAuthSignInSection } from "./OAuthSignInSection";
import { ProviderBadgeTag } from "./ProviderBadgeTag";

export type ProvidersTabProps = {
  settings: ModelsSettingsResponse;
  catalog: RuntimeModelsResponse | null;
  catalogError: string | null;
  /** 変更中の provider id。null なら操作なし */
  saving: string | null;
  sessions: SessionSummary[];
  sessionsLoaded: boolean;
  singleColumn: boolean;
  onSave: (provider: string, apiKey: string) => Promise<boolean>;
  onSaveMemo: (provider: string, memo: string) => Promise<boolean>;
  onDelete: (provider: string) => Promise<boolean>;
  onResync: (provider: string) => Promise<boolean>;
  onLogin: (provider: string) => Promise<boolean>;
  onSubmitLoginCode: (provider: string, code: string) => Promise<boolean>;
  onCancelLogin: (provider: string) => Promise<boolean>;
  onSignOut: (provider: string) => Promise<boolean>;
  /** カスタムプロバイダー（オンメモリ）の作成・更新・削除 */
  onCreateCustom: (body: CreateCustomProviderBody) => Promise<boolean>;
  onUpdateCustom: (provider: string, body: UpdateCustomProviderBody) => Promise<boolean>;
  onDeleteCustom: (provider: string) => Promise<boolean>;
  /** provider ごとの入力下書き (apiKey / memo)。両タブの親が保持する */
  drafts: Record<string, ProviderDraft>;
  /** 下書きのフィールド単位の更新。触っていないフィールドは親側の最新値を保つ */
  onChangeDraft: (provider: string, patch: Partial<ProviderDraft>) => void;
  /** キー登録後にモデルを選びに行く導線 */
  onOpenModels: () => void;
};

/**
 * 「プロバイダー」タブ。左の一覧（全 provider）と右の詳細（キー・メモ・削除・再同期）を
 * 分け、singleColumn では一覧と詳細を切り替える。平文保存の注意は詳細ペインの上部に
 * 常時出し、provider を切り替えても消えない。
 */
export function ProvidersTab({
  settings,
  catalog,
  catalogError,
  saving,
  sessions,
  sessionsLoaded,
  singleColumn,
  onSave,
  onSaveMemo,
  onDelete,
  onResync,
  onLogin,
  onSubmitLoginCode,
  onCancelLogin,
  onSignOut,
  onCreateCustom,
  onUpdateCustom,
  onDeleteCustom,
  drafts,
  onChangeDraft,
  onOpenModels,
}: ProvidersTabProps) {
  const [query, setQuery] = useState("");
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  // 追加モード。既存の選択とは排他で、単独カラムでも一覧を閉じてフォームを出す
  const [addingCustom, setAddingCustom] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const selectorRef = useRef<HTMLButtonElement>(null);
  const focusAfterSelection = useRef(false);
  useEffect(() => {
    if (!singleColumn || listOpen || !focusAfterSelection.current) return;
    focusAfterSelection.current = false;
    selectorRef.current?.focus();
  }, [singleColumn, listOpen]);
  const needle = query.trim().toLowerCase();
  const matched = (provider: ProviderAuthSetting) =>
    needle === "" || provider.provider.toLowerCase().includes(needle) || provider.name.toLowerCase().includes(needle);
  const groups = groupProviders(settings, catalog);
  const sections = [
    { label: `設定済み ${groups.configured.length}`, providers: groups.configured.filter(matched) },
    { label: `未設定 ${groups.unconfigured.length}`, providers: groups.unconfigured.filter(matched) },
  ];
  const visible = sections.flatMap((section) => section.providers);
  const customMatched = settings.customProviders.filter(
    (provider) => needle === "" || provider.id.includes(needle) || provider.name.toLowerCase().includes(needle),
  );
  const selected = settings.providers.find(
    (provider) => provider.provider === selectedProvider && provider.custom !== true,
  );
  // singleColumn では検索中も表示中の詳細を変えない。一覧を選び直したときだけ切り替える
  const active = singleColumn
    ? (selected ?? groups.configured[0] ?? groups.unconfigured[0])
    : (visible.find((provider) => provider.provider === selectedProvider) ?? visible[0]);
  // カスタムプロバイダーは専用セクションが持つ。通常の詳細には流さない（id が同じでも管理の正が別）。
  // 通常の provider が 1 件も無いときは、空の詳細ではなく先頭のカスタム定義を開く
  const customSelected = addingCustom
    ? undefined
    : (settings.customProviders.find((provider) => provider.id === selectedProvider) ??
      (selectedProvider === null && visible.length === 0 ? settings.customProviders[0] : undefined));
  const activeName = addingCustom
    ? CUSTOM_PROVIDER_ADD_LABEL
    : (customSelected?.name ?? active?.name ?? "プロバイダーがありません");
  const detailIsCustom = addingCustom || customSelected !== undefined;
  const busy = saving !== null;
  const saveNote = (
    <div className="border-t border-line bg-soft px-4 py-2.5 text-2xs leading-relaxed text-ink-muted">
      このタブの変更は、各項目の保存ボタンでその場で保存されます（横断の一括保存はありません）。
    </div>
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {singleColumn ? (
        <button
          ref={selectorRef}
          type="button"
          aria-expanded={listOpen}
          onClick={() => setListOpen((open) => !open)}
          className="flex min-h-11 min-w-0 shrink-0 items-center gap-2 border-b border-line px-4 text-left text-xs text-ink-soft"
        >
          {addingCustom ? null : (
            <ProviderIcon
              provider={customSelected?.id ?? active?.provider ?? ""}
              name={customSelected?.name ?? active?.name ?? ""}
              variant="field"
            />
          )}
          <span className="min-w-0 flex-1 truncate">{activeName}</span>
          <span className="shrink-0 text-accent-text">{listOpen ? "詳細に戻る" : "プロバイダーを変更"}</span>
          <DisclosureChevronIcon />
        </button>
      ) : null}
      <div className="flex min-h-0 min-w-0 flex-1">
        {!singleColumn || listOpen ? (
          <div
            className={cn(
              "flex min-h-0 flex-col",
              singleColumn ? "min-w-0 flex-1" : "w-72 shrink-0 border-r border-line",
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
              {needle === "" || customMatched.length > 0 ? (
                <div className="grid gap-0.5 pb-2">
                  <div className="px-1.5 pt-2 pb-0.5 text-3xs tracking-label text-ink-ghost uppercase">
                    {CUSTOM_PROVIDER_SECTION_TITLE}
                  </div>
                  {customMatched.map((provider) => {
                    const isActive = !addingCustom && provider.id === customSelected?.id;
                    return (
                      <button
                        key={provider.id}
                        type="button"
                        aria-current={isActive ? "true" : undefined}
                        onClick={() => {
                          setAddingCustom(false);
                          setSelectedProvider(provider.id);
                          if (singleColumn) {
                            setQuery("");
                            focusAfterSelection.current = true;
                            setListOpen(false);
                          }
                        }}
                        className={cn(
                          "flex w-full items-center gap-2 rounded-lg border px-2 py-1.5 text-left transition-colors",
                          isActive ? "border-accent/40 bg-accent-wash" : "border-transparent hover:bg-hover",
                        )}
                      >
                        <ProviderIcon provider={provider.id} name={provider.name} />
                        <span className="grid min-w-0 flex-1 gap-0.5">
                          <span className="flex min-w-0 items-center gap-2">
                            <span className="min-w-0 flex-1 truncate text-xs text-ink">{provider.name}</span>
                            <span className="text-2xs whitespace-nowrap text-ink-muted">
                              {CUSTOM_PROVIDER_MEMORY_BADGE}
                            </span>
                          </span>
                          <code className="truncate text-2xs text-ink-ghost">
                            {provider.id} · {provider.model.id}
                          </code>
                        </span>
                      </button>
                    );
                  })}
                  <button
                    type="button"
                    className="mt-1 rounded-lg border border-dashed border-line-strong px-2 py-1.5 text-left text-2xs text-accent-text transition-colors hover:bg-hover"
                    aria-expanded={addingCustom}
                    onClick={() => {
                      setAddingCustom(true);
                      setSelectedProvider(null);
                      if (singleColumn) {
                        setQuery("");
                        focusAfterSelection.current = true;
                        setListOpen(false);
                      }
                    }}
                  >
                    {CUSTOM_PROVIDER_ADD_LABEL}
                  </button>
                </div>
              ) : null}
              {visible.length === 0 ? (
                customMatched.length === 0 ? (
                  <p className="px-1.5 py-1.5 text-2xs text-ink-muted">該当するプロバイダーがありません。</p>
                ) : null
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
                            onClick={() => {
                              setSelectedProvider(provider.provider);
                              if (singleColumn) {
                                setQuery("");
                                focusAfterSelection.current = true;
                                setListOpen(false);
                              }
                            }}
                            className={cn(
                              "flex w-full items-center gap-2 rounded-lg border px-2 py-1.5 text-left transition-colors",
                              isActive ? "border-accent/40 bg-accent-wash" : "border-transparent hover:bg-hover",
                            )}
                          >
                            <ProviderIcon provider={provider.provider} name={provider.name} />
                            <span className="grid min-w-0 flex-1 gap-0.5">
                              <span className="flex min-w-0 items-center gap-2">
                                <span className="min-w-0 flex-1 truncate text-xs text-ink">{provider.name}</span>
                                <span
                                  className={cn(
                                    "text-2xs whitespace-nowrap",
                                    meta.warn ? "text-warn" : "text-ink-muted",
                                  )}
                                >
                                  {meta.text}
                                </span>
                              </span>
                              <code className="truncate text-2xs text-ink-ghost">{provider.provider}</code>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  ),
                )
              )}
            </div>
          </div>
        ) : null}

        {!singleColumn || !listOpen ? (
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
              {detailIsCustom ? (
                <>
                  <CustomProviderNotes />
                  <CustomProviderForm
                    key={addingCustom ? "__new" : customSelected?.id}
                    provider={customSelected ?? null}
                    runtimeAvailable={settings.runtimeAvailable}
                    saving={customSelected !== undefined && saving === customSelected.id}
                    busy={busy}
                    onCreate={onCreateCustom}
                    onUpdate={onUpdateCustom}
                    onDelete={onDeleteCustom}
                    onSaved={(id) => {
                      setAddingCustom(false);
                      setSelectedProvider(id);
                    }}
                    onDeleted={() => {
                      setAddingCustom(false);
                      setSelectedProvider(null);
                    }}
                    onCancelAdd={() => setAddingCustom(false)}
                  />
                </>
              ) : active ? (
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
                  onLogin={onLogin}
                  onSubmitLoginCode={onSubmitLoginCode}
                  onCancelLogin={onCancelLogin}
                  onSignOut={onSignOut}
                  drafts={drafts}
                  onChangeDraft={onChangeDraft}
                  onOpenModels={onOpenModels}
                />
              ) : (
                <p className="rounded-lg border border-line bg-soft px-2.5 py-2 text-xs text-ink-muted">
                  プロバイダーがありません。
                </p>
              )}
            </div>
            {singleColumn ? <div className="-mx-4 mt-4">{saveNote}</div> : null}
          </div>
        ) : null}
      </div>

      {!singleColumn ? saveNote : null}
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

/** キーが平文で保存されることと、BFF を公開しない注意。詳細ペインの共通位置に既定で畳んで出す */
function SecurityNotice() {
  return (
    <CollapsibleNotice summary="キーとメモは平文で保存されます。ログインがないため公開しないでください。">
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
    </CollapsibleNotice>
  );
}

/**
 * カスタムプロバイダーの注意。オンメモリであることと、再起動後に残るモデル選択の扱いを、
 * 追加・編集のどちらでも読めるように常時出す（短い注意だけを画面に置き、理由は docs が持つ）。
 */
function CustomProviderNotes() {
  return (
    <section className="grid gap-1 rounded-lg border border-warn/40 bg-raised px-2.5 py-2 text-2xs leading-relaxed text-ink-soft">
      <p className="text-warn">{CUSTOM_PROVIDER_NOTES[0]}</p>
      {CUSTOM_PROVIDER_NOTES.slice(1).map((note) => (
        <p key={note}>{note}</p>
      ))}
    </section>
  );
}

/** 対処が要る案内（未反映 / この画面のキーが保存済みの OAuth を覆っている）。同じ見た目を詳細の複数箇所で使う */
function WarnNote({ children }: { children: string }) {
  return (
    <p
      role="alert"
      className="rounded-md border border-warn/40 bg-raised px-2.5 py-1.5 text-2xs leading-relaxed text-warn"
    >
      {children}
    </p>
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
  onLogin,
  onSubmitLoginCode,
  onCancelLogin,
  onSignOut,
  drafts,
  onChangeDraft,
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
  onLogin: (provider: string) => Promise<boolean>;
  onSubmitLoginCode: (provider: string, code: string) => Promise<boolean>;
  onCancelLogin: (provider: string) => Promise<boolean>;
  onSignOut: (provider: string) => Promise<boolean>;
  drafts: Record<string, ProviderDraft>;
  onChangeDraft: (provider: string, patch: Partial<ProviderDraft>) => void;
  onOpenModels: () => void;
}) {
  const badge = providerAuthBadge(provider);
  const notice = degradedNotice(provider);
  const hiddenNotice = hiddenStoredOAuthNotice(provider);
  const catalogProvider = catalog?.providers.find((entry) => entry.provider === provider.provider);
  const available = availableCountOf(catalog, provider.provider);
  const credentialTabs = providerCredentialTabs(provider);
  // タブの選択はこの画面のローカル状態 (URL には載せない)。provider を切り替えると親がこの要素を
  // 作り直すため、実効側の既定へ戻る
  const [authTab, setAuthTab] = useState<CredentialTab>(credentialTabs.initial);
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

  // タブの中ではタブ名が見出しの役割を持つため、セクション自身の見出しは消す
  const apiKeySection = (heading: boolean) => (
    <ApiKeySection
      provider={provider}
      runtimeAvailable={runtimeAvailable}
      saving={saving}
      busy={busy}
      heading={heading}
      drafts={drafts}
      onChangeDraft={onChangeDraft}
      onSave={onSave}
      onSaveMemo={onSaveMemo}
      onDelete={onDelete}
      onResync={onResync}
    />
  );
  const signInSection = (heading: boolean) => (
    <OAuthSignInSection
      provider={provider}
      runtimeAvailable={runtimeAvailable}
      busy={busy}
      heading={heading}
      onLogin={onLogin}
      onSubmitCode={onSubmitLoginCode}
      onCancel={onCancelLogin}
      onSignOut={onSignOut}
    />
  );

  return (
    <section className="grid gap-4">
      <div className="grid gap-2 border-b border-line pb-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <ProviderIcon provider={provider.provider} name={provider.name} variant="heading" />
          <h2 className="text-md font-semibold text-ink-strong">{provider.name}</h2>
          <code className="text-2xs text-ink-ghost">{provider.provider}</code>
          <ProviderBadgeTag badge={badge} />
          {catalogProvider ? (
            <MetaChip>
              利用可能 {available} / カタログ {catalogProvider.models.length}
            </MetaChip>
          ) : null}
        </div>
        {keyUpdatedLabel || usageLabel ? (
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1.5">
            {keyUpdatedLabel ? <MetaChip>{keyUpdatedLabel}</MetaChip> : null}
            {usageLabel ? <MetaChip>{usageLabel}</MetaChip> : null}
          </div>
        ) : null}
      </div>

      {notice ? <WarnNote>{notice}</WarnNote> : null}
      {hiddenNotice ? <WarnNote>{hiddenNotice}</WarnNote> : null}
      {provider.orphan ? (
        <p className="text-2xs leading-relaxed text-ink-muted">
          現在のカタログに無い provider です。
          {provider.managed
            ? "保存済みのキーは削除できます（カタログに戻るまで再登録はできません）。"
            : "キーの登録はできません（メモは保存できます）。"}
        </p>
      ) : null}

      {/* 2 経路とも使える provider だけタブで分ける。切替ではサインインのパネルをアンマウントせず
          (進行中の表示と、自分が開いた空タブの参照を保つ)、非表示側を hidden / inert で外す */}
      {credentialTabs.visible ? (
        <div className="grid gap-3">
          <CredentialTabs view={credentialTabs} active={authTab} providerName={provider.name} onSelect={setAuthTab} />
          <div hidden={authTab !== "api_key"} inert={authTab !== "api_key"}>
            {apiKeySection(false)}
          </div>
          <div hidden={authTab !== "sign_in"} inert={authTab !== "sign_in"}>
            {signInSection(false)}
          </div>
        </div>
      ) : (
        <>
          {signInSection(true)}
          {apiKeySection(true)}
        </>
      )}

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
