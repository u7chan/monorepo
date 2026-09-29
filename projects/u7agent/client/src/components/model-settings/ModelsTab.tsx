import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { cn } from "../../lib/cn";
import {
  AVAILABILITY_SAVE_INITIAL,
  availabilityCounts,
  availabilityDraftIsDirty,
  availabilityNotice,
  availabilitySaveConfirmMessage,
  availabilitySaveOnSubmit,
  candidateGroups,
  defaultModelOptions,
  filterCandidateGroups,
  normalizeAllowedModels,
  setAvailabilityProviderModels,
  type AvailabilityDraft,
  type AvailabilitySaveState,
  type CandidateGroup,
} from "../../lib/modelSettings";
import type { ModelsSettingsResponse, RuntimeModelsResponse, UpdateModelAvailabilityBody } from "../../types";
import { CheckIcon, DisclosureChevronIcon } from "../icons";
import { ProviderIcon } from "../ProviderIcon";
import { ModelDefaultPicker } from "./ModelDefaultPicker";
import { ProviderBadgeTag } from "./ProviderBadgeTag";

export type ModelsTabProps = {
  settings: ModelsSettingsResponse;
  catalog: RuntimeModelsResponse | null;
  catalogError: string | null;
  saving: boolean;
  draft: AvailabilityDraft;
  initialDraft: AvailabilityDraft;
  setDraft: Dispatch<SetStateAction<AvailabilityDraft>>;
  onSave: (input: UpdateModelAvailabilityBody) => Promise<ModelsSettingsResponse | null>;
  compact: boolean;
};

/**
 * 「モデルを選ぶ」タブ。選択（allowedModels）とアプリ既定モデルを下書きとして編集する。
 * 下書きは親が持つため、タブを切り替えても未保存の選択は失われない。
 */
export function ModelsTab({
  settings,
  catalog,
  catalogError,
  saving,
  draft,
  initialDraft,
  setDraft,
  onSave,
  compact,
}: ModelsTabProps) {
  const [query, setQuery] = useState("");
  const [selectedOnly, setSelectedOnly] = useState(false);
  const [closedProviders, setClosedProviders] = useState<Set<string>>(new Set());
  const [openedProviders, setOpenedProviders] = useState<Set<string>>(new Set());
  const [saveState, setSaveState] = useState<AvailabilitySaveState>(AVAILABILITY_SAVE_INITIAL);

  // 編集不可は取得失敗 (catalogError) だけで判定する。catalog === null は初期ロード中も真になる
  const blocked = catalogError !== null;
  const loading = catalog === null;
  const groups = candidateGroups(draft, catalog, settings);
  const counts = availabilityCounts(groups);
  const notice = availabilityNotice(draft, catalog);
  const dirty = availabilityDraftIsDirty(draft, initialDraft);
  const filtered = filterCandidateGroups(groups, query, selectedOnly);
  const searching = query.trim() !== "";
  // 選択 0 件は保存不可。空配列を送ると API が制限なしへ正規化し、意図と逆になるため
  const noSelection = counts.selected === 0;
  const canSave = dirty && !saving && !loading && !blocked && !noSelection;
  const confirmMessage = dirty ? availabilitySaveConfirmMessage(saveState, notice) : undefined;
  const authenticatedProviders = groups.filter((group) => group.authenticated).length;

  // 下書きが変わったら確認をやり直す (前の内容への同意を、違う内容の保存へ流用しない)
  useEffect(() => {
    setSaveState(AVAILABILITY_SAVE_INITIAL);
  }, [draft]);

  // 折りたたみは既定で閉じる。検索中は当たった provider を、警告のある provider は対処が必要な
  // 状態を見せるため開く。以降の開閉は利用者が持つ
  const isGroupOpen = (provider: string, hasWarning: boolean) =>
    searching || (!closedProviders.has(provider) && (openedProviders.has(provider) || hasWarning));
  const toggleGroup = (provider: string, next: boolean) => {
    setClosedProviders((current) => {
      const updated = new Set(current);
      if (next) updated.delete(provider);
      else updated.add(provider);
      return updated;
    });
    setOpenedProviders((current) => {
      const updated = new Set(current);
      if (next) updated.add(provider);
      else updated.delete(provider);
      return updated;
    });
  };

  const submit = async () => {
    if (!canSave) return;
    // 確認の文言は純関数が組み立てる。send が false の押下では PUT を送らない
    const next = availabilitySaveOnSubmit(saveState, notice);
    setSaveState(next.state);
    if (!next.send) return;
    await onSave({ allowedModels: normalizeAllowedModels(draft.allowed), defaultModel: draft.defaultModel });
  };

  const statusText = saving
    ? "保存中…"
    : blocked
      ? "モデル一覧を取得できないため保存できません。"
      : loading
        ? "モデル一覧を読み込んでいます。"
        : noSelection
          ? "選択したモデルが 0 件のため保存できません。空の選択は API で「制限なし（全モデル）」へ正規化されるため、この画面からは送りません。"
          : confirmMessage
            ? confirmMessage
            : dirty
              ? "モデル候補に未保存の変更があります"
              : "未保存の変更はありません";

  return (
    <div className="flex min-h-0 min-w-0 flex-col">
      <div className="min-h-0 min-w-0 flex-1 scrollbar-thin overflow-x-hidden overflow-y-auto px-4 py-4">
        <div className="mx-auto grid max-w-3xl gap-5">
          <section className="grid gap-2">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <h3 className="text-2xs font-semibold tracking-label text-ink-faint uppercase">既定モデル</h3>
              {catalog ? <span className="text-2xs text-ink-muted">{counts.available} モデルが利用可能</span> : null}
            </div>
            <ModelDefaultPicker
              options={defaultModelOptions(draft, catalog)}
              value={draft.defaultModel}
              disabled={saving || loading}
              onChange={(key) => setDraft((current) => ({ ...current, defaultModel: key }))}
            />
            {noSelection && !loading && !blocked ? (
              <p className="text-2xs leading-relaxed text-ink-muted">
                選択したモデルがありません。「モデル候補」から 1 つ以上選ぶと既定モデルを選べます。
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs">
              <span className="text-ink-soft">新しい会話で選べるモデル</span>
              <span className="text-ink">
                選択 {counts.selected} / 利用可能 {counts.available}
              </span>
              <span className="text-ink-muted">チェックしたモデルだけが候補になります</span>
            </div>
            {notice.warning ? (
              <p role="alert" className="rounded-md border border-warn/40 bg-raised px-2.5 py-1.5 text-2xs text-warn">
                {notice.warning}
              </p>
            ) : null}
          </section>

          <section className="grid gap-2">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-line pb-1.5">
              <h3 className="text-2xs font-semibold tracking-label text-ink-faint uppercase">モデル候補</h3>
              {catalog ? (
                <span className="text-2xs text-ink-muted">
                  認証済みの provider {authenticatedProviders} ・ モデル {counts.available}
                </span>
              ) : null}
            </div>

            {blocked ? (
              <p role="alert" className="rounded-md border border-warn/40 bg-raised px-2.5 py-2 text-2xs text-warn">
                モデル一覧を取得できないため、モデル候補は編集できません。（{catalogError}）
              </p>
            ) : loading ? (
              <p role="status" className="text-2xs text-ink-muted">
                モデル一覧を読み込んでいます。
              </p>
            ) : (
              <>
                <p className="text-2xs leading-relaxed text-ink-soft">
                  新しい会話で使えるモデルを選びます。保存した内容は新しい会話のモデル候補とアプリ既定モデルに効き、開いている会話のモデルは切り替えません。
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="search"
                    className="field min-w-0 flex-1 text-xs"
                    value={query}
                    placeholder="provider / モデル名 / ID で絞り込み"
                    aria-label="モデル候補を絞り込む"
                    onChange={(event) => setQuery(event.currentTarget.value)}
                  />
                  <label className="flex min-h-11 cursor-pointer items-center gap-1.5 text-2xs text-ink-soft">
                    <input
                      type="checkbox"
                      className="size-4 shrink-0 accent-focus"
                      checked={selectedOnly}
                      onChange={(event) => setSelectedOnly(event.currentTarget.checked)}
                    />
                    選択済みのみ
                  </label>
                </div>

                {filtered.length === 0 ? (
                  <p className="rounded-lg border border-line bg-soft px-2.5 py-2 text-xs text-ink-muted">
                    条件に合うモデルがありません。
                  </p>
                ) : (
                  <div className="grid gap-2">
                    {filtered.map((group) => (
                      <CandidateGroupSection
                        key={group.provider}
                        group={group}
                        compact={compact}
                        saving={saving}
                        forceOpen={searching}
                        open={isGroupOpen(group.provider, Boolean(group.warning))}
                        onToggle={toggleGroup}
                        onSelectAll={(selected) =>
                          setDraft((current) =>
                            setAvailabilityProviderModels(current, group.provider, selected, catalog),
                          )
                        }
                        onToggleModel={(key) =>
                          setDraft((current) => {
                            const allowed = current.allowed.includes(key)
                              ? current.allowed.filter((entry) => entry !== key)
                              : [...current.allowed, key];
                            // 外したモデルが既定のまま残ると保存が 400 になるため、同時に未設定へ戻す
                            const defaultModel = current.defaultModel === key ? null : current.defaultModel;
                            return { ...current, allowed, defaultModel };
                          })
                        }
                      />
                    ))}
                  </div>
                )}

                <p className="text-2xs leading-relaxed text-ink-muted">
                  APIキーや認証が設定済みのプロバイダーだけを表示しています。追加するには「プロバイダー」タブで登録します。登録が無いプロバイダーに残った選択は候補に出さず、次に保存したときに外れます。
                </p>
              </>
            )}
          </section>

          {settings.ignoredEnvironmentVariables.length > 0 ? (
            <p className="border-t border-line pt-3 text-2xs leading-relaxed text-warn">
              環境変数{" "}
              {settings.ignoredEnvironmentVariables.map((name) => (
                <code key={name} className="mr-1">
                  {name}
                </code>
              ))}
              は無視されます。設定 → モデル の内容だけが使われるため、デプロイ設定からは削除してください。
            </p>
          ) : null}

          <section className="grid gap-1.5">
            <h3 className="text-2xs font-semibold tracking-label text-ink-faint uppercase">保存について</h3>
            <p className="text-2xs leading-relaxed text-ink-muted">
              登録したキーはアプリのデータベース（SQLite）へ平文で保存され、「プロバイダー」タブからのみ変更できます。保存したキーは再表示しません。保存しても開いている会話のモデルは切り替わりません。
            </p>
          </section>
        </div>
      </div>

      <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-line bg-soft px-4 py-2.5">
        <div className="min-w-0 flex-1">
          {saving ? (
            <p role="status" className="text-2xs text-ink-muted">
              保存中…
            </p>
          ) : confirmMessage ? (
            <p role="alert" className="text-2xs leading-relaxed text-warn">
              {confirmMessage}
            </p>
          ) : (
            <p role="status" className={cn("text-2xs leading-relaxed", noSelection ? "text-warn" : "text-ink-muted")}>
              {statusText}
            </p>
          )}
        </div>
        <div className="ml-auto flex shrink-0 flex-wrap items-center gap-2">
          {confirmMessage ? (
            <>
              <button
                type="button"
                className="btn-quiet"
                disabled={saving}
                onClick={() => setSaveState(AVAILABILITY_SAVE_INITIAL)}
              >
                キャンセル
              </button>
              <button type="button" className="btn-primary" disabled={!canSave} onClick={() => void submit()}>
                <CheckIcon />
                保存する
              </button>
            </>
          ) : (
            <>
              {dirty ? (
                <button type="button" className="btn-quiet" disabled={saving} onClick={() => setDraft(initialDraft)}>
                  変更を破棄
                </button>
              ) : null}
              <button type="button" className="btn-primary" disabled={!canSave} onClick={() => void submit()}>
                <CheckIcon />
                {saving ? "保存中…" : "モデル候補を保存"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** モデル候補の provider 1 件。折りたたみ中は行を描画しない (開いたときだけ children を組む) */
function CandidateGroupSection({
  group,
  compact,
  saving,
  forceOpen,
  open,
  onToggle,
  onSelectAll,
  onToggleModel,
}: {
  group: CandidateGroup;
  compact: boolean;
  saving: boolean;
  forceOpen: boolean;
  open: boolean;
  onToggle: (provider: string, next: boolean) => void;
  onSelectAll: (selected: boolean) => void;
  onToggleModel: (key: string) => void;
}) {
  const expanded = forceOpen || open;
  return (
    <details
      className="overflow-hidden rounded-lg border border-line bg-soft"
      open={expanded}
      onToggle={(event) => onToggle(group.provider, event.currentTarget.open)}
    >
      <summary className="disclosure-summary flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 px-2.5 py-2 transition-colors outline-none hover:bg-raised/60 focus-visible:ring-1 focus-visible:ring-focus focus-visible:ring-inset">
        <DisclosureChevronIcon />
        <ProviderIcon provider={group.provider} name={group.name} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium text-ink">{group.name}</span>
          <code className="block truncate text-2xs text-ink-ghost">{group.provider}</code>
        </span>
        {compact ? null : (
          <>
            <ProviderBadgeTag badge={group.badge} />
            <span className="text-2xs whitespace-nowrap text-ink-muted">
              利用可能 {group.availableCount}/{group.catalogCount} ・ 選択 {group.selectedCount}
            </span>
          </>
        )}
      </summary>
      {expanded ? (
        <div className="grid gap-1 border-t border-line p-2">
          {group.warning ? (
            <p className="rounded-md border border-warn/40 bg-raised px-2.5 py-1.5 text-2xs leading-relaxed text-warn">
              {group.warning}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <span className="text-2xs text-ink-muted">APIキーやメモの管理は「プロバイダー」タブで行います</span>
            <span className="flex flex-wrap items-center gap-1.5">
              {group.authenticated ? (
                <button type="button" className="btn-quiet" disabled={saving} onClick={() => onSelectAll(true)}>
                  すべて選択
                </button>
              ) : null}
              <button
                type="button"
                className="btn-quiet"
                disabled={saving || group.selectedCount === 0}
                onClick={() => onSelectAll(false)}
              >
                すべて解除
              </button>
            </span>
          </div>
          {group.rows.length === 0 ? (
            <p className="px-1 py-1 text-2xs text-ink-muted">この provider のモデルはありません。</p>
          ) : (
            <>
              <div className={cn("flex items-center gap-x-3 px-1 text-3xs text-ink-muted", compact ? "" : "pr-4")}>
                <span aria-hidden className="size-4 shrink-0" />
                <span className="min-w-0 flex-1">モデル</span>
                {compact ? null : <span className="min-w-0 flex-1">ID</span>}
                <span className="w-20 shrink-0 text-right">利用可能</span>
              </div>
              {group.rows.map((row) => (
                <label
                  key={row.key}
                  title={row.key}
                  className="flex min-h-9 cursor-pointer items-center gap-x-3 rounded px-1 text-xs transition-colors hover:bg-raised/60"
                >
                  <input
                    type="checkbox"
                    className="size-4 shrink-0 accent-focus"
                    checked={row.checked}
                    disabled={saving}
                    onChange={() => onToggleModel(row.key)}
                  />
                  <span className="min-w-0 flex-1 truncate text-xs text-ink">{row.name}</span>
                  {compact ? null : (
                    <code className="min-w-0 flex-1 truncate text-2xs text-ink-muted" title={row.key}>
                      {row.key}
                    </code>
                  )}
                  <span
                    className={cn(
                      "w-20 shrink-0 text-right text-2xs whitespace-nowrap",
                      row.available ? "text-ok" : "text-ink-ghost",
                    )}
                  >
                    {row.available ? "はい" : "いいえ"}
                  </span>
                </label>
              ))}
            </>
          )}
        </div>
      ) : null}
    </details>
  );
}
