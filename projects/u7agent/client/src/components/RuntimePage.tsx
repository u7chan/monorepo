import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { getRuntimeEnvironment, getRuntimeModels } from "../api";
import { cn } from "../lib/cn";
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
  runtimeMetricRatio,
  runtimeProviderRows,
  runtimeProviderSummaryRows,
  type RuntimeModelDisplayRow,
  type RuntimeProviderDisplayRow,
} from "../lib/runtimeModels";
import type { Health, RuntimeEnvironmentResponse, RuntimeEnvironmentState, RuntimeModelsResponse } from "../types";
import { CheckMark, DisclosureChevronIcon, KeyIcon, RefreshIcon, WhitelistMark } from "./icons";
import { SettingsPageLayout, type SettingsPageProps } from "./SettingsPageLayout";

type RuntimePageProps = SettingsPageProps & {
  health: Health | null;
  /**
   * 親が持つ health の再取得。`isCurrent` を渡し、古い応答を親の state へ適用させない。
   * null (取得失敗 / キャンセル) は失敗として扱う。
   */
  onRefreshHealth: (isCurrent?: () => boolean) => Promise<Health | null>;
};

export function RuntimePage({ health, onRefreshHealth, compact = false, onBack, onOpenNav }: RuntimePageProps) {
  const [catalogState, setCatalogState] = useState<RuntimeFetchState<RuntimeModelsResponse>>({ status: "loading" });
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
        getModels: getRuntimeModels,
        getEnvironment: getRuntimeEnvironment,
      });
      // アンマウント / 再試行で古くなった応答は、失敗した系統の前回値を含めて何も適用しない
      if (!isCurrent()) return;
      if (results.health) setHealthFailed(!results.health.ok);
      setCatalogState(runtimeFetchStateOf(results.models));
      setEnvironmentState(runtimeFetchStateOf(results.environment));
      setPending(false);
    },
    [gate, onRefreshHealth],
  );

  useEffect(() => {
    // 親が health を持つため、画面を開いたときはモデルカタログと実行環境だけ取得する
    void runLoad(false);
    return () => gate.invalidate();
  }, [gate, runLoad]);

  const diagnostics = health?.runtimeDiagnostics;
  const diagnosticRows = diagnostics ? runtimeDiagnosticRows(diagnostics) : { piModel: undefined, piModels: [] };
  const diagnosticCounts = diagnostics ? runtimeDiagnosticCounts(diagnostics) : undefined;
  const summaryProviderRows = runtimeProviderSummaryRows(diagnostics?.providers ?? []);
  const catalogResponse = catalogState.status === "ready" ? catalogState.value : undefined;
  const providerRows = catalogResponse ? runtimeProviderRows(catalogResponse) : [];
  const versions = diagnostics?.versions ?? catalogResponse?.versions;
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
            <h3 className="text-2xs font-semibold tracking-label text-ink-faint uppercase">モデル解決</h3>
            {diagnostics?.status === "unavailable" ? (
              <p className="text-xs text-ink-muted">診断情報を取得できません。</p>
            ) : diagnostics?.status === "available" ? (
              <>
                {diagnosticCounts ? (
                  <MetricGauges {...diagnosticCounts} availableLabel="利用可能 (whitelist 適用前)" />
                ) : (
                  <p className="text-xs text-ink-muted">カタログ数は取得できていません。</p>
                )}
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

          <section className="grid gap-2 rounded-lg border border-line bg-soft p-3">
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
              <h3 className="text-2xs font-semibold tracking-label text-ink-faint uppercase">プロバイダーとカタログ</h3>
              {catalogResponse ? (
                <MetricGauges
                  catalog={catalogResponse.catalogCount}
                  whitelist={catalogResponse.whitelistCount}
                  available={catalogResponse.availableCount}
                />
              ) : null}
            </div>
            {catalogState.status === "loading" ? (
              <p role="status" className="text-xs text-ink-muted">
                モデルのカタログを読み込んでいます。
              </p>
            ) : catalogState.status === "error" ? (
              <p role="alert" className="text-xs text-danger-text">
                モデルのカタログを取得できませんでした。{catalogState.message}
              </p>
            ) : providerRows.length === 0 ? (
              <p className="text-xs text-ink-muted">カタログにプロバイダーがありません。</p>
            ) : (
              <div className="grid gap-1">
                {providerRows.map((provider) => (
                  <ProviderDetails key={provider.provider} provider={provider} />
                ))}
              </div>
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

const GAUGE_TONE = {
  catalog: "text-ink-ghost",
  whitelist: "text-accent-text",
  available: "text-ok",
} as const;

type GaugeTone = keyof typeof GAUGE_TONE;

/**
 * カタログ数を分母にした比率ゲージ。数値だけでは 4/41 と 4/1495 の読み分けができないため、
 * 同じ分母の棒を並べて比べる。分母が 0 のときは塗らない。
 */
function MetricGauge({ label, value, total, tone }: { label: string; value: number; total: number; tone: GaugeTone }) {
  // 51/1495 のような小さい比率でも 1px に潰れないよう、0 以外は最小幅を持たせる
  const filled = value > 0 ? Math.max(64 * runtimeMetricRatio(value, total), 3) : 0;
  return (
    <span className="grid gap-1">
      <span className="flex items-baseline gap-1">
        <span className="text-3xs whitespace-nowrap text-ink-faint">{label}</span>
        <span className="font-mono text-2xs text-ink-soft tabular-nums">{value}</span>
      </span>
      {/* 目盛りは無色にする。空のゲージが色付きの帯に見えると「0 件」を成功と読み違える */}
      <svg aria-hidden="true" viewBox="0 0 64 4" className="h-1 w-16 text-line-strong">
        <rect width="64" height="4" rx="2" fill="currentColor" />
        <rect width={filled} height="4" rx="2" className={cn("fill-current", GAUGE_TONE[tone])} />
      </svg>
    </span>
  );
}

/** 3 つのゲージを 1 組にする。全体サマリとプロバイダー行で同じ分母 (カタログ数) を使う */
function MetricGauges({
  catalog,
  whitelist,
  available,
  availableLabel = "利用可能",
}: {
  catalog: number;
  whitelist: number;
  available: number;
  availableLabel?: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <MetricGauge label="カタログ" value={catalog} total={catalog} tone="catalog" />
      <MetricGauge label="whitelist 収載" value={whitelist} total={catalog} tone="whitelist" />
      <MetricGauge label={availableLabel} value={available} total={catalog} tone="available" />
    </div>
  );
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

function ProviderDetails({ provider }: { provider: RuntimeProviderDisplayRow }) {
  return (
    <details open={provider.configured} className="overflow-hidden rounded-md border border-line bg-raised">
      <summary className="disclosure-summary block cursor-pointer px-2.5 py-2 transition-colors outline-none hover:bg-soft/40 focus-visible:ring-1 focus-visible:ring-focus focus-visible:ring-inset">
        <ProviderHeadline provider={provider} leading={<DisclosureChevronIcon />} />
      </summary>
      <div className="grid gap-2 border-t border-line px-2.5 py-2">
        <AuthSource provider={provider} />
        {provider.models.length === 0 ? (
          <p className="text-2xs text-ink-muted">このプロバイダーのカタログモデルはありません。</p>
        ) : (
          <ProviderModelTable models={provider.models} />
        )}
      </div>
    </details>
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

/** モデル名と ID を別の列に分ける。同じ行に続けて出すと、名前と識別子の境目が読めない */
function ProviderModelTable({ models }: { models: RuntimeProviderDisplayRow["models"] }) {
  return (
    <table className="w-full table-fixed border-collapse text-2xs">
      <thead>
        <tr className="text-3xs text-ink-muted">
          <th scope="col" className="w-1/3 pr-2 pb-1 text-left font-medium">
            モデル
          </th>
          <th scope="col" className="w-1/3 pr-2 pb-1 text-left font-medium">
            ID
          </th>
          <th scope="col" className="w-1/6 pr-2 pb-1 text-left font-medium">
            利用可能
          </th>
          <th scope="col" className="w-1/6 pb-1 text-left font-medium">
            whitelist
          </th>
        </tr>
      </thead>
      <tbody>
        {models.map((model) => (
          <tr key={model.id} className="border-t border-line/60 align-top transition-colors hover:bg-soft/40">
            <td className="py-1 pr-2 break-words text-ink">{model.name}</td>
            <td className="py-1 pr-2 font-mono break-all text-ink-muted">{model.id}</td>
            <td className="py-1 pr-2">
              <BooleanFact label={yesNo(model.available)} ok={model.available} />
            </td>
            <td className="py-1">
              <WhitelistFact label={model.inWhitelist ? "収載" : "対象外"} inWhitelist={model.inWhitelist} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function yesNo(value: boolean): string {
  return value ? "はい" : "いいえ";
}
