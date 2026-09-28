import { useRef, useState } from "react";
import { useModelSettings, type ModelSettings } from "../hooks/useModelSettings";
import { cn } from "../lib/cn";
import { availabilityDraftFromSettings, availabilityDraftIsDirty, type AvailabilityDraft } from "../lib/modelSettings";
import { DEFAULT_MODELS_SUBSECTION, MODELS_SUBSECTIONS, type ModelsSubsection } from "../lib/settingsNav";
import type { Health, SessionSummary } from "../types";
import { RefreshIcon } from "./icons";
import { ModelsTab } from "./model-settings/ModelsTab";
import { ProvidersTab } from "./model-settings/ProvidersTab";
import { SettingsPageLayout, type SettingsPageProps } from "./SettingsPageLayout";

export type ModelSettingsPageProps = SettingsPageProps & {
  /** キーの変更後に composer のモデル候補を更新する (画面を開いている間だけ使う) */
  onRefreshHealth: (isCurrent?: () => boolean) => Promise<Health | null>;
  /** 最終使用の導出元。facade が持つセッション一覧を渡す (この画面では取得しない) */
  sessions: SessionSummary[];
  /** 一覧の初回取得に成功したか。false の間は最終使用の行を出さない */
  sessionsLoaded: boolean;
  /** URL が決めるタブ。既定は「モデルを選ぶ」 */
  modelsSubsection: ModelsSubsection;
  onSelectModelsSubsection: (subsection: ModelsSubsection) => void;
};

/**
 * 設定 → モデル。「モデルを選ぶ / プロバイダー」の 2 タブを持ち、表示の正は URL
 * (`/settings/models` と `/settings/models/providers`) に置く。hook はこの画面が持つ
 * (カタログ全件を起動のたびに読まない。開いたときだけ取得する)。
 */
export function ModelSettingsPage({
  onRefreshHealth,
  modelsSubsection,
  onSelectModelsSubsection,
  compact,
  onBack,
  onOpenNav,
  sessions,
  sessionsLoaded,
}: ModelSettingsPageProps) {
  return (
    <ModelSettingsView
      modelSettings={useModelSettings({ onRefreshHealth })}
      modelsSubsection={modelsSubsection}
      onSelectModelsSubsection={onSelectModelsSubsection}
      sessions={sessions}
      sessionsLoaded={sessionsLoaded}
      compact={compact}
      onBack={onBack}
      onOpenNav={onOpenNav}
    />
  );
}

/** 取得前の下書きの置き場。settings が届くと同じ render で保存値から作り直す */
const EMPTY_DRAFT: AvailabilityDraft = { allowed: [], defaultModel: null };

/** 表示だけを持つ部分。取得の成否は modelSettings が持ち、ここはタブと描画に徹する */
export function ModelSettingsView({
  modelSettings,
  sessions = [],
  sessionsLoaded = false,
  compact = false,
  modelsSubsection = DEFAULT_MODELS_SUBSECTION,
  onSelectModelsSubsection,
  onBack,
  onOpenNav,
}: SettingsPageProps & {
  modelSettings: ModelSettings;
  sessions?: SessionSummary[];
  sessionsLoaded?: boolean;
  modelsSubsection?: ModelsSubsection;
  onSelectModelsSubsection?: (subsection: ModelsSubsection) => void;
}) {
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
    saveMemo,
    saveAvailability,
    remove,
    resync,
  } = modelSettings;
  // 下書きは両タブの親が持つ。タブを切り替えて片方が unmount しても、未保存の選択と既定モデルを失わない
  const [draft, setDraft] = useState<AvailabilityDraft>(EMPTY_DRAFT);
  const appliedInitial = useRef<AvailabilityDraft | null>(null);
  const initialDraft = settings ? availabilityDraftFromSettings(settings, catalog) : null;
  // 初期下書きが変わったときだけ下書きを作り直す。catalog の到着でも null (旧・制限なし) の展開が
  // 変わるため、Effect の遅延で古い下書きを見せないよう render 中に同期させる
  if (initialDraft && (!appliedInitial.current || availabilityDraftIsDirty(initialDraft, appliedInitial.current))) {
    appliedInitial.current = initialDraft;
    setDraft(initialDraft);
  }

  return (
    <SettingsPageLayout
      eyebrow="MODELS"
      title="モデル"
      caption="使うモデルと、プロバイダーごとのAPIキーを設定します。保存した内容は再起動後も使われます。"
      actions={
        <button type="button" className="btn-quiet" onClick={() => void reload()} disabled={reloading}>
          <RefreshIcon />
          再読み込み
        </button>
      }
      tabs={
        <div role="tablist" aria-label="モデルの設定" className="flex shrink-0 gap-1 border-b border-line px-4">
          {MODELS_SUBSECTIONS.map((item) => (
            <button
              key={item.subsection}
              type="button"
              role="tab"
              aria-selected={modelsSubsection === item.subsection}
              onClick={() => onSelectModelsSubsection?.(item.subsection)}
              className={cn("tab-item", modelsSubsection === item.subsection && "tab-item-active")}
            >
              {item.label}
            </button>
          ))}
        </div>
      }
      note={note}
      compact={compact}
      onOpenNav={onOpenNav}
      onBack={onBack}
    >
      {settings ? (
        modelsSubsection === "providers" ? (
          <ProvidersTab
            settings={settings}
            catalog={catalog}
            catalogError={catalogError}
            saving={saving}
            sessions={sessions}
            sessionsLoaded={sessionsLoaded}
            compact={compact}
            onSave={save}
            onSaveMemo={saveMemo}
            onDelete={remove}
            onResync={resync}
            onOpenModels={() => onSelectModelsSubsection?.(DEFAULT_MODELS_SUBSECTION)}
          />
        ) : (
          <ModelsTab
            settings={settings}
            catalog={catalog}
            catalogError={catalogError}
            saving={savingAvailability}
            draft={draft}
            initialDraft={initialDraft ?? draft}
            setDraft={setDraft}
            onSave={saveAvailability}
            compact={compact}
          />
        )
      ) : (
        <div className="min-h-0 min-w-0 scrollbar-thin overflow-x-hidden overflow-y-auto px-4 py-4">
          <div className="mx-auto grid max-w-3xl gap-3">
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
          </div>
        </div>
      )}
    </SettingsPageLayout>
  );
}
