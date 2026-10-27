import { useState } from "react";
import { useElapsedMs } from "../../hooks/useElapsedMs";
import { cn } from "../../lib/cn";
import {
  WEB_SEARCH_TEST_DEFAULT_QUERY,
  WEB_SEARCH_TEST_QUERY_MAX_LENGTH,
  WEB_SEARCH_TOOL_NAME,
  webSearchKeyMissingNotice,
  webSearchProviderDef,
  webSearchTestCountLabel,
  webSearchTestDisabledReason,
  webSearchTestDurationLabel,
  webSearchTestElapsedLabel,
  webSearchTestNotice,
  webSearchTestOutputSizeLabel,
  webSearchTestQueryError,
  type WebSearchTestOutcome,
} from "../../lib/webSearchSettings";
import type { WebSearchSettingsResponse } from "../../types";
import { CheckIcon, RunSpinnerIcon, SearchIcon, WarningIcon } from "../icons";
import { MetaChip } from "../model-settings/MetaChip";
import { OutputPanel } from "../OutputPanel";

export type WebSearchTestCardProps = {
  settings: WebSearchSettingsResponse;
  /** 設定の保存中。保存中は押せない (保存済みの設定でだけ検索する) */
  busy: boolean;
  testing: boolean;
  outcome: WebSearchTestOutcome | null;
  /** 保存していない APIキーの下書きがある。押す前に保存を促す */
  unsavedKey: boolean;
  onTest: (query: string) => void;
};

/**
 * 設定 → Web 検索のテスト検索。保存済みの設定で 1 回だけ検索し、モデルへ返る本文をそのまま出す。
 * 枠は出力パネル 1 枚だけで、状態はその上の 1 行 (アイコン + 文字) が持つ。
 */
export function WebSearchTestCard({ settings, busy, testing, outcome, unsavedKey, onTest }: WebSearchTestCardProps) {
  const [query, setQuery] = useState(WEB_SEARCH_TEST_DEFAULT_QUERY);
  const [startedAt, setStartedAt] = useState<number | undefined>(undefined);
  const elapsedMs = useElapsedMs(testing ? startedAt : undefined);
  const providerDef = webSearchProviderDef(settings);
  const disabledReason = webSearchTestDisabledReason(settings);
  const queryError = webSearchTestQueryError(query);
  const keyMissing = webSearchKeyMissingNotice(providerDef);
  // OFF は押させない (kill switch を迂回させない)。空のときだけ押せなくし、理由は下に出す
  const submitDisabled = busy || testing || disabledReason !== undefined || queryError !== undefined;

  return (
    <section className="grid gap-2.5 border-t border-line pt-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-2xs font-semibold tracking-label text-ink-soft uppercase">テスト検索</span>
      </div>
      <p className="text-2xs leading-relaxed text-ink-muted">
        保存済みの設定で 1 回だけ検索し、モデルへ返る本文をそのまま出します。会話・履歴・設定には何も残しません。
      </p>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (submitDisabled) return;
          setStartedAt(Date.now());
          onTest(query);
        }}
      >
        <input
          className="field min-w-0 flex-1 text-xs"
          value={query}
          maxLength={WEB_SEARCH_TEST_QUERY_MAX_LENGTH}
          aria-label="テスト検索のクエリ"
          spellCheck={false}
          disabled={busy || testing || disabledReason !== undefined}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
        <button type="submit" className="btn-primary" disabled={submitDisabled}>
          {testing ? <RunSpinnerIcon tone="on-accent" /> : <SearchIcon />}
          {testing && elapsedMs !== undefined ? `検索中… ${webSearchTestElapsedLabel(elapsedMs)}` : "テスト検索"}
        </button>
      </form>
      {settings.enabled ? (
        <p className="text-2xs leading-relaxed text-ink-muted">{webSearchTestNotice(providerDef)}</p>
      ) : null}
      {disabledReason ? <p className="text-2xs leading-relaxed text-ink-muted">{disabledReason}</p> : null}
      {!disabledReason && queryError ? <p className="text-2xs text-ink-muted">{queryError}</p> : null}
      {!disabledReason && unsavedKey ? (
        <p className="text-2xs leading-relaxed text-warn">
          未保存のAPIキーがあります。保存してからテストすると、そのキーで検索します。
        </p>
      ) : null}
      {!disabledReason && !unsavedKey && keyMissing ? (
        <p className="text-2xs leading-relaxed text-warn">{keyMissing}</p>
      ) : null}
      {outcome ? <TestResult outcome={outcome} /> : null}
    </section>
  );
}

/** 結果。成功 / 失敗はアイコン + 文字 + 出力パネルで示し、枠を重ねない */
function TestResult({ outcome }: { outcome: WebSearchTestOutcome }) {
  const { query, result } = outcome;
  const durationLabel = webSearchTestDurationLabel(result.durationMs);
  return (
    <div className="grid gap-1" role={result.ok ? "status" : "alert"}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className={result.ok ? "text-accent-text" : "text-danger-text"}>
          {result.ok ? <CheckIcon /> : <WarningIcon />}
        </span>
        <span className={cn("text-2xs font-semibold", result.ok ? "text-accent-text" : "text-danger-text")}>
          {result.ok ? "成功" : "失敗"}
        </span>
        {result.provider ? (
          <>
            <MetaChip>{result.provider.name}</MetaChip>
            <code className="text-2xs text-ink-ghost">{result.provider.host}</code>
            <MetaChip>{webSearchTestCountLabel(result.resultCount)}</MetaChip>
          </>
        ) : null}
        {durationLabel ? <span className="text-2xs text-ink-faint">{durationLabel}</span> : null}
        <span className="ml-auto min-w-0 truncate text-2xs text-ink-faint">クエリ「{query}」</span>
      </div>
      <OutputPanel
        label={WEB_SEARCH_TOOL_NAME}
        meta={webSearchTestOutputSizeLabel(result.output)}
        text={result.output}
        mono
        scroll
        copyLabel="出力をコピー"
      />
    </div>
  );
}
