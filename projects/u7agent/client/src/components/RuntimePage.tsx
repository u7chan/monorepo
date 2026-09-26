import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "../lib/cn";
import { getRuntimeEnvironment } from "../api";
import {
  createRuntimeReloadGate,
  reloadRuntime,
  runtimeCommandRows,
  runtimeEnvironmentSummary,
  runtimeFetchStateOf,
  type RuntimeFetchState,
  type RuntimeReloadGate,
} from "../lib/runtimeEnvironment";
import {
  runtimeDiagnosticCounts,
  runtimeDiagnosticRows,
  runtimeProviderSummaryRows,
  type RuntimeModelDisplayRow,
  type RuntimeProviderDisplayRow,
} from "../lib/runtimeModels";
import type { Health, RuntimeEnvironmentResponse, RuntimeEnvironmentState } from "../types";
import { CheckMark, KeyIcon, RefreshIcon, WhitelistMark } from "./icons";
import { MetricGauges } from "./runtimeMetrics";
import { SettingsPageLayout, type SettingsPageProps } from "./SettingsPageLayout";

type RuntimePageProps = SettingsPageProps & {
  health: Health | null;
  /**
   * 親が持つ health の再取得。`isCurrent` を渡し、古い応答を親の state へ適用させない。
   * null (取得失敗 / キャンセル) は失敗として扱う。
   */
  onRefreshHealth: (isCurrent?: () => boolean) => Promise<Health | null>;
};

/**
 * 設定 → ランタイム。接続状態・実行環境・利用可能コマンド・モデル解決の診断だけを出す表示専用の画面。
 * プロバイダー認証とカタログは設定 → モデルへ移設した (ここではモデル候補を取らない)。
 */
export function RuntimePage({ health, onRefreshHealth, compact = false, onBack, onOpenNav }: RuntimePageProps) {
  const [environmentState, setEnvironmentState] = useState<RuntimeFetchState<RuntimeEnvironmentResponse>>({
    status: "loading",
  });
  const [healthFailed, setHealthFailed] = useState(false);
  const [pending, setPending] = useState(true);
  const gateRef = useRef<RuntimeReloadGate | null>(null);
  if (gateRef.current === null) gateRef.current = createRuntimeReloadGate();
  const gate = gateRef.current;

  const runLoad = useCallback(
    async (includeHealth: boolean) => {
      const isCurrent = gate.begin();
      setPending(true);
      const results = await reloadRuntime({
        includeHealth,
        isCurrent,
        refreshHealth: onRefreshHealth,
        getEnvironment: getRuntimeEnvironment,
      });
      // アンマウント / 再試行で古くなった応答は、失敗した系統の前回値を含めて何も適用しない
      if (!isCurrent()) return;
      if (results.health) setHealthFailed(!results.health.ok);
      setEnvironmentState(runtimeFetchStateOf(results.environment));
      setPending(false);
    },
    [gate, onRefreshHealth],
  );

  useEffect(() => {
    // 親が health を持つため、画面を開いたときは実行環境だけ取得する
    void runLoad(false);
    return () => gate.invalidate();
  }, [gate, runLoad]);

  const diagnostics = health?.runtimeDiagnostics;
  const diagnosticRows = diagnostics ? runtimeDiagnosticRows(diagnostics) : { piModel: undefined, piModels: [] };
  const diagnosticCounts = diagnostics ? runtimeDiagnosticCounts(diagnostics) : undefined;
  const summaryProviderRows = runtimeProviderSummaryRows(diagnostics?.providers ?? []);
  const versions = diagnostics?.versions;
  const environment = environmentState.status === "ready" ? environmentState.value : undefined;
  const commandRows = environment?.state === "connected" ? runtimeCommandRows(environment.commands) : [];

  return (
    <SettingsPageLayout
      eyebrow="RUNTIME"
      title="ランタイム"
      caption="接続状態・実行環境・モデル解決の診断を表示します。設定の変更は行いません。"
      actions={
        <button type="button" className="btn-quiet" onClick={() => void runLoad(true)} disabled={pending}>
          <RefreshIcon />
          再読み込み
        </button>
      }
      compact={compact}
      onOpenNav={onOpenNav}
      onBack={onBack}
    >
      <div className="min-h-0 min-w-0 scrollbar-thin overflow-x-hidden overflow-y-auto px-4 py-4">
        <div className="mx-auto grid max-w-4xl gap-3">
          <section className="grid gap-2 rounded-lg border border-line bg-soft p-3">
            <h3 className="text-2xs font-semibold tracking-label text-ink-faint uppercase">接続状態</h3>
            {healthFailed ? (
              <p role="alert" className="text-2xs text-danger-text">
                接続状態を再取得できませんでした。前回の値を表示しています。
              </p>
            ) : null}
            <dl className="grid gap-2 text-xs sm:grid-cols-2">
              <InfoItem
                label="ランタイム"
                value={health ? (health.ready ? "利用可能" : "利用できません") : "情報なし"}
              />
              <InfoItem
                label="サンドボックス"
                value={health ? (health.sandboxConfigured ? "設定済み" : "未設定") : "情報なし"}
              />
              <InfoItem
                label="既定モデル"
                value={health?.model ?? "指定なし"}
                note="アプリの既定モデルです。会話中に使われている実効モデルではありません。"
              />
              <InfoItem label="作業ディレクトリ (cwd)" value={health?.cwd ?? "情報なし"} />
              <InfoItem label="セッションストア" value={storeStatus(health?.sessionStore)} />
              <InfoItem label="アプリ DB" value={dbStatus(health?.appDb)} />
            </dl>
            <div className="grid gap-1 border-t border-line pt-2 text-2xs text-ink-muted">
              <span>pi-coding-agent: {versions?.piCodingAgent ?? "情報なし"}</span>
              {versions?.piAi ? <span>pi-ai: {versions.piAi}</span> : null}
              {versions?.commitHash ? <span>COMMIT_HASH: {versions.commitHash}</span> : null}
            </div>
          </section>

          <section className="grid gap-2 rounded-lg border border-line bg-soft p-3">
            <h3 className="text-2xs font-semibold tracking-label text-ink-faint uppercase">
              実行環境（サンドボックス側）
            </h3>
            {environmentState.status === "loading" ? (
              <p role="status" className="text-xs text-ink-muted">
                実行環境を取得しています。
              </p>
            ) : environmentState.status === "error" ? (
              <p role="alert" className="text-xs text-danger-text">
                実行環境を取得できませんでした。{environmentState.message}
              </p>
            ) : environmentState.value.state === "connected" ? (
              <dl className="grid gap-2 text-xs sm:grid-cols-2">
                <EnvironmentStatusItem state="connected" />
                <InfoItem label="OS" value={environmentState.value.environment.os} />
                <InfoItem label="アーキテクチャ" value={environmentState.value.environment.arch} />
                <InfoItem
                  label="実行ユーザー"
                  value={`${environmentState.value.environment.user}（${environmentState.value.environment.isRoot ? "root" : "非 root"}）`}
                  note={
                    environmentState.value.environment.isRoot
                      ? "root で動いています。コンテナ外への影響を避けるため、非 root 実行を推奨します。"
                      : undefined
                  }
                />
                <InfoItem label="ワークスペース" value={environmentState.value.environment.workspace} />
              </dl>
            ) : (
              <EnvironmentStatusItem state={environmentState.value.state} />
            )}
          </section>

          <section className="grid gap-2 rounded-lg border border-line bg-soft p-3">
            <h3 className="text-2xs font-semibold tracking-label text-ink-faint uppercase">利用可能なコマンド</h3>
            {environmentState.status === "loading" ? (
              <p role="status" className="text-xs text-ink-muted">
                コマンドを検出しています。
              </p>
            ) : environmentState.status === "error" || environmentState.value.state !== "connected" ? (
              <p className="text-xs text-ink-muted">
                実行環境の情報を取得できていないため、コマンドは表示していません。
              </p>
            ) : commandRows.length === 0 ? (
              <p className="text-xs text-ink-muted">検出できたコマンドはありません。</p>
            ) : (
              <>
                <table className="w-full table-fixed border-collapse text-2xs">
                  <thead>
                    <tr className="text-3xs text-ink-muted">
                      <th scope="col" className="w-1/2 pr-2 pb-1 text-left font-medium">
                        コマンド
                      </th>
                      <th scope="col" className="w-1/2 pb-1 text-left font-medium">
                        バージョン
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {commandRows.map((row) => (
                      <tr key={row.key} className="border-t border-line/60 align-top">
                        <td className="py-1 pr-2 font-mono break-all text-ink">{row.name}</td>
                        <td
                          className={cn(
                            "py-1 break-all",
                            row.version === "バージョン不明" ? "text-ink-faint" : "text-ink-muted",
                          )}
                        >
                          {row.version}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="text-2xs text-ink-muted">実際に検出できたコマンドだけを表示します。</p>
              </>
            )}
          </section>

          <section className="grid gap-2 rounded-lg border border-line bg-soft p-3">
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
              <h3 className="text-2xs font-semibold tracking-label text-ink-faint uppercase">モデル解決</h3>
              {diagnosticCounts ? (
                <MetricGauges {...diagnosticCounts} availableLabel="利用可能 (whitelist 適用前)" />
              ) : null}
            </div>
            {diagnostics?.status === "unavailable" ? (
              <p className="text-xs text-ink-muted">診断情報を取得できません。</p>
            ) : diagnostics?.status === "available" ? (
              <>
                {diagnosticCounts ? null : <p className="text-xs text-ink-muted">カタログ数は取得できていません。</p>}
                <p className="text-2xs text-ink-muted">
                  PI_MODELS: {diagnostics.whitelistConfigured ? "whitelist を設定" : "制限なし"}
                </p>
                <DiagnosticRows
                  title="PI_MODEL"
                  rows={diagnosticRows.piModel ? [diagnosticRows.piModel] : []}
                  empty="指定なし"
                />
                <DiagnosticRows title="PI_MODELS" rows={diagnosticRows.piModels} empty="指定なし" />
                <ProviderSummary rows={summaryProviderRows} />
              </>
            ) : (
              <p className="text-xs text-ink-muted">health から診断サマリを取得できていません。</p>
            )}
          </section>
        </div>
      </div>
    </SettingsPageLayout>
  );
}

function InfoItem({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="grid min-w-0 gap-0.5">
      <dt className="text-2xs text-ink-faint">{label}</dt>
      <dd className="break-all text-ink">{value}</dd>
      {note ? <p className="text-2xs leading-relaxed text-ink-muted">{note}</p> : null}
    </div>
  );
}

const STATUS_TONE = {
  ok: "bg-ok",
  muted: "bg-ink-ghost",
  danger: "bg-danger",
} as const;

/**
 * 実行環境カードの接続状態。`connected` は診断 API の正常応答だけを表し、
 * 接続状態カードの「サンドボックス = 設定済み」(設定の有無) とは別の意味を持つ。
 */
function EnvironmentStatusItem({ state }: { state: RuntimeEnvironmentState }) {
  const summary = runtimeEnvironmentSummary(state);
  return (
    <div className="grid min-w-0 gap-0.5">
      <dt className="text-2xs text-ink-faint">接続状態</dt>
      <dd className="flex items-center gap-1.5 text-ink">
        <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", STATUS_TONE[summary.tone])} />
        {summary.label}
      </dd>
      {state === "connected" ? null : <p className="text-2xs leading-relaxed text-ink-muted">{summary.detail}</p>}
    </div>
  );
}

function storeStatus(store: Health["sessionStore"]): string {
  if (!store) return "情報なし";
  return `${store.ok ? "利用可能" : "利用できません"} · ${store.path ?? "永続化なし"}`;
}

function dbStatus(db: Health["appDb"]): string {
  if (!db) return "情報なし";
  return `${db.ok ? "利用可能" : "利用できません"} · ${db.path ?? "永続化なし"}`;
}

function BooleanFact({ label, ok }: { label: string; ok: boolean }) {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap text-ink-muted">
      <CheckMark ok={ok} />
      {label}
    </span>
  );
}

function WhitelistFact({ label, inWhitelist }: { label: string; inWhitelist: boolean }) {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap text-ink-muted">
      <WhitelistMark inWhitelist={inWhitelist} />
      {label}
    </span>
  );
}

function DiagnosticRows({ title, rows, empty }: { title: string; rows: RuntimeModelDisplayRow[]; empty: string }) {
  return (
    <div className="grid gap-1 border-t border-line pt-2">
      <h4 className="text-2xs font-semibold text-ink-soft">{title}</h4>
      {rows.length === 0 ? (
        <p className="text-2xs text-ink-muted">{empty}</p>
      ) : (
        rows.map((row) => (
          <div key={row.key} className="grid gap-1.5 rounded-md bg-raised px-2.5 py-2">
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <code className="text-2xs break-all text-ink">{row.label}</code>
              <span className="text-2xs text-ink-soft">{row.statusLabel}</span>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <BooleanFact label="カタログ" ok={row.cataloged} />
              <BooleanFact label="認証" ok={row.authenticated} />
              <BooleanFact label="利用可能" ok={row.available} />
              <WhitelistFact label="whitelist" inWhitelist={row.inWhitelist} />
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function ProviderSummary({ rows }: { rows: RuntimeProviderDisplayRow[] }) {
  return (
    <div className="grid gap-1 border-t border-line pt-2">
      <h4 className="text-2xs font-semibold text-ink-soft">プロバイダー集計</h4>
      {rows.length === 0 ? (
        <p className="text-2xs text-ink-muted">参照されたプロバイダー、認証済みプロバイダーはありません。</p>
      ) : (
        rows.map((row) => (
          <div key={row.provider} className="grid gap-1.5 rounded-md bg-raised px-2.5 py-2">
            <ProviderHeadline provider={row} />
            <AuthSource provider={row} />
          </div>
        ))
      )}
    </div>
  );
}

/** プロバイダー 1 行の見出し。折りたたみの summary と集計の行で同じ見た目を使う */
function ProviderHeadline({ provider, leading }: { provider: RuntimeProviderDisplayRow; leading?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      {leading}
      <code title={provider.provider} className="min-w-0 flex-1 text-1xs break-all text-ink">
        {provider.provider}
      </code>
      <span
        className={cn(
          "inline-flex shrink-0 items-center gap-1 text-2xs",
          provider.configured ? "text-ok" : "text-ink-faint",
        )}
      >
        <KeyIcon />
        {provider.configured ? "認証済み" : "未認証"}
      </span>
      <MetricGauges
        catalog={provider.catalogCount}
        whitelist={provider.whitelistCount}
        available={provider.availableCount}
      />
    </div>
  );
}

function AuthSource({ provider }: { provider: RuntimeProviderDisplayRow }) {
  return (
    <p className="text-2xs text-ink-muted">
      認証ソース: {provider.authSource}
      {provider.environmentVariables.length > 0 ? (
        <>
          {" "}
          · 環境変数:{" "}
          {provider.environmentVariables.map((name) => (
            <code key={name} className="ml-1">
              {name}
            </code>
          ))}
        </>
      ) : null}
    </p>
  );
}
