import { useState } from "react";
import { cn } from "../../lib/cn";
import {
  sessionTitleDefinitionError,
  sessionTitleEffortForModel,
  sessionTitleEffortNotice,
  sessionTitleEffortOptions,
  sessionTitleEffortValue,
  sessionTitleModelOptions,
  sessionTitleModelUnavailableNotice,
  sessionTitleModelValue,
  sessionTitleStatusBadge,
  TITLE_DEFINITION_MAX,
  type SessionTitleSavingAction,
} from "../../lib/sessionTitleSettings";
import type { ThinkingLevel, TitleSummarySettingsResponse } from "../../types";
import { MetaChip } from "../model-settings/MetaChip";
import { ProviderBadgeTag } from "../model-settings/ProviderBadgeTag";
import { SelectMenu, type SelectMenuOption } from "../SelectMenu";
import { ToggleSwitch } from "../ToggleSwitch";

export type SessionTitleSettingsTabProps = {
  settings: TitleSummarySettingsResponse;
  /** 実行中の操作。null なら操作なし */
  saving: SessionTitleSavingAction | null;
  onSetEnabled: (enabled: boolean) => Promise<boolean>;
  onSelectModel: (model: string, thinkingLevel: ThinkingLevel | null) => Promise<boolean>;
  onSelectEffort: (thinkingLevel: ThinkingLevel) => Promise<boolean>;
  onSaveDefinition: (definition: string) => Promise<boolean>;
  onResetDefinition: () => Promise<boolean>;
};

/**
 * 設定 → 会話タイトルの本文。AI 要約の On/Off・要約モデル・Effort・定義を 1 面にまとめる。
 * 生成のタイミングと回数は固定 (初回の本文あり正常完了後に最大 1 試行) で、この画面では変えられない。
 */
export function SessionTitleSettingsTab({
  settings,
  saving,
  onSetEnabled,
  onSelectModel,
  onSelectEffort,
  onSaveDefinition,
  onResetDefinition,
}: SessionTitleSettingsTabProps) {
  const busy = saving !== null;
  const { enabled } = settings;
  const [draft, setDraft] = useState(settings.definition);
  const [draftFor, setDraftFor] = useState(settings.definition);
  // 保存応答で定義が変わったら下書きも追随する (打ちかけの編集は上書きしない)
  if (draftFor !== settings.definition) {
    setDraftFor(settings.definition);
    if (draft === draftFor) setDraft(settings.definition);
  }
  const invalid = sessionTitleDefinitionError(draft);
  const dirty = draft.trim() !== settings.definition;
  const unavailable = sessionTitleModelUnavailableNotice(settings);
  const modelValue = sessionTitleModelValue(settings);
  const modelOptions: SelectMenuOption<string>[] = [
    ...(modelValue === "" ? [{ value: "", label: "未選択", detail: "", disabled: true }] : []),
    ...sessionTitleModelOptions(settings.models),
  ];
  const effortValue = sessionTitleEffortValue(settings);
  const effortOptions: SelectMenuOption<ThinkingLevel | "">[] = [
    ...(effortValue === "" ? [{ value: "" as const, label: "モデルを選択してください", disabled: true }] : []),
    ...sessionTitleEffortOptions(settings).map((option) => ({
      value: option.value,
      label: option.label,
      description: option.description,
      disabled: option.disabled,
    })),
  ];
  const effortNotice = sessionTitleEffortNotice(settings);
  const hasEffortChoices = effortOptions.some((option) => option.value !== "");

  return (
    <div className="min-h-0 min-w-0 scrollbar-thin overflow-x-hidden overflow-y-auto px-4 py-4">
      <div className="mx-auto grid max-w-3xl gap-3">
        <section className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line pb-2">
          <h2 className="text-md font-semibold text-ink-strong">会話タイトル</h2>
          <ProviderBadgeTag badge={sessionTitleStatusBadge(enabled)} />
          <MetaChip>初回完了後に最大1試行</MetaChip>
        </section>

        <section
          className={cn(
            "grid gap-2 rounded-lg border p-3",
            enabled ? "border-line bg-soft" : "border-warn/50 bg-raised",
          )}
        >
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <div className="min-w-0 flex-1">
              <div className="text-2xs font-semibold tracking-label text-ink-faint uppercase">AI要約</div>
              <p className="mt-0.5 text-xs text-ink">
                依頼本文から作ったタイトルを、初回の正常完了後に 1 回だけ AI で整えます。
              </p>
            </div>
            <ToggleSwitch
              checked={enabled}
              label={enabled ? "On" : "Off"}
              disabled={busy}
              onChange={(next) => void onSetEnabled(next)}
            />
          </div>
          {/* On にする前に、送信先・費用・試行回数の方針を同じ面で確認できるようにする */}
          <ul className="grid gap-1 text-2xs leading-relaxed text-ink-muted">
            <li>・送信先は下で選んだ要約モデルのプロバイダーです。本会話のモデルとは独立しています。</li>
            <li>・短い入力と出力でも、プロバイダーの課金対象になります（費用は診断の usage で確認できます）。</li>
            <li>・自動実行は会話ごとに最大 1 試行です。失敗しても仮タイトルのまま、再試行しません。</li>
            <li>・会話の送信・保存・次の送信は、タイトル生成の完了を待ちません。</li>
            <li>・手動で変えたタイトルは上書きしません。タイトルのためだけにモデルへ送る本文は変えません。</li>
          </ul>
          {enabled ? null : (
            <p className="rounded border border-line bg-base px-2 py-1.5 text-2xs leading-relaxed text-ink-muted">
              Off の間はタイトル用の AI 呼び出しを行いません。依頼本文から作るタイトルと手動の改名はそのまま使えます。
            </p>
          )}
        </section>

        <div className="grid gap-3 wide:grid-cols-2">
          <section className="grid gap-1.5">
            <div className="text-2xs font-semibold tracking-label text-ink-faint uppercase">要約モデル</div>
            <SelectMenu
              label="要約モデル"
              value={modelValue}
              options={modelOptions}
              note="AI要約だけに使うモデルです。選んだ時点で保存されます。"
              disabled={busy}
              onChange={(next) => {
                if (next === "") return;
                void onSelectModel(next, sessionTitleEffortForModel(settings, next, settings.effectiveThinkingLevel));
              }}
            />
            {settings.models.length === 0 ? (
              <p className="text-2xs leading-relaxed text-ink-muted">
                選択できるモデルがありません。設定 → モデル でプロバイダーの認証を済ませてください。
              </p>
            ) : null}
            {unavailable ? (
              <p className="rounded border border-warn/50 bg-raised px-2 py-1.5 text-2xs leading-relaxed text-ink">
                {unavailable}
              </p>
            ) : null}
          </section>

          <section className="grid gap-1.5">
            <div className="text-2xs font-semibold tracking-label text-ink-faint uppercase">Effort</div>
            <SelectMenu
              label="Effort"
              value={effortValue}
              options={effortOptions}
              note="要約モデルが対応する段階だけを選べます。未指定のときはモデルの最小段階を使います。"
              disabled={busy || !settings.model || !settings.modelAvailable || !hasEffortChoices}
              onChange={(next) => {
                if (next !== "") void onSelectEffort(next);
              }}
            />
            {settings.model ? null : (
              <p className="text-2xs leading-relaxed text-ink-muted">先に要約モデルを選ぶと Effort を選べます。</p>
            )}
            {effortNotice ? (
              <p className="rounded border border-warn/50 bg-raised px-2 py-1.5 text-2xs leading-relaxed text-ink">
                {effortNotice}
              </p>
            ) : null}
          </section>
        </div>

        <section className="grid gap-1.5">
          <div className="text-2xs font-semibold tracking-label text-ink-faint uppercase">要約の定義</div>
          <p className="text-2xs leading-relaxed text-ink-muted">
            言語・長さ・重視する情報・文体を指定できます。ツール禁止・出力の検証・秘密値のマスクはこの定義では解除できません。
          </p>
          <textarea
            className="field min-h-36 text-xs leading-relaxed"
            rows={6}
            maxLength={TITLE_DEFINITION_MAX}
            aria-label="要約の定義"
            value={draft}
            disabled={busy}
            onChange={(event) => setDraft(event.currentTarget.value)}
          />
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-2xs text-ink-faint">
              {draft.trim().length} / {TITLE_DEFINITION_MAX}
            </span>
            <div className="ml-auto flex items-center gap-2">
              <button
                type="button"
                className="btn-quiet"
                disabled={busy || draft === settings.defaultDefinition}
                onClick={() => void onResetDefinition()}
              >
                既定に戻す
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={busy || !dirty || invalid !== undefined}
                onClick={() => void onSaveDefinition(draft)}
              >
                定義を保存
              </button>
            </div>
          </div>
          {invalid && dirty ? <p className="text-2xs text-danger-text">{invalid}</p> : null}
        </section>
      </div>
    </div>
  );
}
