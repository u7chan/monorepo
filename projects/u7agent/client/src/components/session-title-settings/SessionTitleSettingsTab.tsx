import { useState } from "react";
import { cn } from "../../lib/cn";
import { effortLabel } from "../../lib/composerSettings";
import { formatCost } from "../../lib/usageFormat";
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
import type { ThinkingLevel, TitleSummarySettingsResponse, TitleSummaryTestResponse } from "../../types";
import { MetaChip } from "../model-settings/MetaChip";
import { OutputPanel } from "../OutputPanel";
import { ProviderBadgeTag } from "../model-settings/ProviderBadgeTag";
import { SelectMenu, type SelectMenuOption } from "../SelectMenu";
import { ToggleSwitch } from "../ToggleSwitch";
import { CheckIcon, RunSpinnerIcon, SparkleIcon, WarningIcon } from "../icons";

export type SessionTitleSettingsTabProps = {
  settings: TitleSummarySettingsResponse;
  /** 実行中の操作。null なら操作なし */
  saving: SessionTitleSavingAction | null;
  onSetEnabled: (enabled: boolean) => Promise<boolean>;
  onSelectModel: (model: string, thinkingLevel: ThinkingLevel | null) => Promise<boolean>;
  onSelectEffort: (thinkingLevel: ThinkingLevel) => Promise<boolean>;
  onSaveDefinition: (definition: string) => Promise<boolean>;
  onResetDefinition: () => Promise<boolean>;
  /** 保存済みの設定で 1 回だけ生成する */
  testing: boolean;
  testResult: TitleSummaryTestResponse | null;
  onTest: () => void;
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
  testing,
  testResult,
  onTest,
}: SessionTitleSettingsTabProps) {
  const busy = saving !== null || testing;
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
  const testDisabled = busy || testing || !settings.enabled || !settings.model || !settings.modelAvailable;
  const testHint = !settings.enabled
    ? "AI要約を On にすると動作確認できます。"
    : !settings.model
      ? "要約モデルを選ぶと動作確認できます。"
      : !settings.modelAvailable
        ? "選択したモデルが現在利用できないため、動作確認できません。"
        : undefined;

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
            <li>・送信先は要約モデルのプロバイダー（本会話とは別）</li>
            <li>・短い入出力でも課金対象（usage は診断で確認）</li>
            <li>・自動実行は会話ごとに 1 回だけ（失敗しても再試行しない）</li>
            <li>・会話の送信・保存はタイトル生成を待たない</li>
            <li>・手動で変えたタイトルは上書きしない</li>
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

        {/* 定義を確認してから試せるよう、動作確認は定義の直後に置く。枠は出力パネル 1 枚だけにする */}
        <section className="grid gap-2 border-t border-line pt-3.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <div className="min-w-0 flex-1">
              <div className="text-2xs font-semibold tracking-label text-ink-faint uppercase">動作確認</div>
              <p className="mt-0.5 text-xs text-ink">
                保存済みのモデル / Effort / 定義で 1 回だけ生成します。会話にもタイトルにも保存しません。
              </p>
            </div>
            <button type="button" className="btn-quiet" disabled={testDisabled} onClick={onTest}>
              {testing ? <RunSpinnerIcon /> : <SparkleIcon />}
              {testing ? "確認中…" : "動作確認"}
            </button>
          </div>
          {testHint ? <p className="text-2xs leading-relaxed text-ink-muted">{testHint}</p> : null}
          {testResult ? <TestResult result={testResult} /> : null}
        </section>
      </div>
    </div>
  );
}

/** 動作確認の結果。成功 / 失敗は 1 行のアイコン + 文字で示し、枠は出力パネル 1 枚だけにする */
function TestResult({ result }: { result: TitleSummaryTestResponse }) {
  const usage =
    result.inputTokens === undefined && result.outputTokens === undefined
      ? undefined
      : `入力 ${result.inputTokens ?? 0} / 出力 ${result.outputTokens ?? 0}${
          result.costTotal === undefined ? "" : ` ・ ${formatCost(result.costTotal)}`
        }`;
  const seconds = result.durationMs > 0 ? `${(result.durationMs / 1000).toFixed(1)} 秒` : undefined;
  const title = result.title ?? "";
  return (
    <div className="grid gap-1" role={result.ok ? "status" : "alert"}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className={result.ok ? "text-accent-text" : "text-danger-text"}>
          {result.ok ? <CheckIcon /> : <WarningIcon />}
        </span>
        <span className={cn("text-2xs font-semibold", result.ok ? "text-accent-text" : "text-danger-text")}>
          {result.ok ? "成功" : "失敗"}
        </span>
        {result.model ? <MetaChip>{result.model}</MetaChip> : null}
        {result.thinkingLevel ? <MetaChip>Effort {effortLabel(result.thinkingLevel)}</MetaChip> : null}
        {usage ? <MetaChip>{usage}</MetaChip> : null}
        {seconds ? <span className="text-2xs text-ink-faint">{seconds}</span> : null}
      </div>
      {result.ok ? (
        <OutputPanel label="title" meta={`${title.length} 文字`} text={title} copyLabel="タイトルをコピー" />
      ) : (
        <OutputPanel label="error" text={result.error ?? "生成に失敗しました"} />
      )}
    </div>
  );
}
