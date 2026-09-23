import { useEffect, useState } from "react";
import { getRuntimeModels } from "../api";
import type { Health, RuntimeModelsResponse } from "../types";
import {
  runtimeDiagnosticRows,
  runtimeProviderRows,
  runtimeProviderSummaryRows,
  type RuntimeModelDisplayRow,
  type RuntimeProviderDisplayRow,
} from "../lib/runtimeModels";
import { RefreshIcon } from "./icons";
import { SettingsPageLayout, type SettingsPageProps } from "./SettingsPageLayout";

type RuntimePageProps = SettingsPageProps & {
  health: Health | null;
};

type CatalogState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; response: RuntimeModelsResponse };

export function RuntimePage({ health, compact = false, onBack, onOpenNav }: RuntimePageProps) {
  const [catalogState, setCatalogState] = useState<CatalogState>({ status: "loading" });
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let current = true;
    setCatalogState({ status: "loading" });
    void getRuntimeModels().then(
      (response) => {
        if (current) setCatalogState({ status: "ready", response });
      },
      (error: unknown) => {
        if (!current) return;
        setCatalogState({
          status: "error",
          message: error instanceof Error ? error.message : "モデル情報を取得できませんでした。",
        });
      },
    );
    return () => {
      current = false;
    };
  }, [reloadToken]);

  const diagnostics = health?.runtimeDiagnostics;
  const diagnosticRows = diagnostics ? runtimeDiagnosticRows(diagnostics) : { piModel: undefined, piModels: [] };
  const summaryProviderRows = runtimeProviderSummaryRows(diagnostics?.providers ?? []);
  const catalogResponse = catalogState.status === "ready" ? catalogState.response : undefined;
  const providerRows = catalogResponse ? runtimeProviderRows(catalogResponse) : [];
  const versions = diagnostics?.versions ?? catalogResponse?.versions;

  return (
    <SettingsPageLayout
      eyebrow="RUNTIME"
      title="ランタイム"
      caption="接続状態とモデル解決の診断を表示します。設定の変更は行いません。"
      actions={
        <button
          type="button"
          className="btn-quiet"
          onClick={() => setReloadToken((token) => token + 1)}
          disabled={catalogState.status === "loading"}
        >
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
            <h3 className="text-2xs font-semibold tracking-label text-ink-faint uppercase">モデル解決</h3>
            {diagnostics?.status === "unavailable" ? (
              <p className="text-xs text-ink-muted">診断情報を取得できません。</p>
            ) : diagnostics?.status === "available" ? (
              <>
                <div className="grid gap-2 text-xs sm:grid-cols-3">
                  <InfoItem label="カタログ" value={countLabel(diagnostics.catalogCount)} />
                  <InfoItem label="whitelist 収載" value={countLabel(diagnostics.whitelistCount)} />
                  <InfoItem label="利用可能 (whitelist 適用前)" value={countLabel(diagnostics.availableCount)} />
                </div>
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
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-2xs font-semibold tracking-label text-ink-faint uppercase">プロバイダーとカタログ</h3>
              {catalogResponse ? (
                <span className="text-2xs text-ink-muted">
                  カタログ {catalogResponse.catalogCount} · whitelist 収載 {catalogResponse.whitelistCount} · 利用可能{" "}
                  {catalogResponse.availableCount}
                </span>
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

function storeStatus(store: Health["sessionStore"]): string {
  if (!store) return "情報なし";
  return `${store.ok ? "利用可能" : "利用できません"} · ${store.path ?? "永続化なし"}`;
}

function dbStatus(db: Health["appDb"]): string {
  if (!db) return "情報なし";
  return `${db.ok ? "利用可能" : "利用できません"} · ${db.path ?? "永続化なし"}`;
}

function countLabel(count: number | undefined): string {
  return count === undefined ? "情報なし" : String(count);
}

function DiagnosticRows({ title, rows, empty }: { title: string; rows: RuntimeModelDisplayRow[]; empty: string }) {
  return (
    <div className="grid gap-1 border-t border-line pt-2">
      <h4 className="text-2xs font-semibold text-ink-soft">{title}</h4>
      {rows.length === 0 ? (
        <p className="text-2xs text-ink-muted">{empty}</p>
      ) : (
        rows.map((row) => (
          <div
            key={row.key}
            className="flex flex-wrap items-center justify-between gap-1 rounded-md bg-raised px-2.5 py-2 text-2xs"
          >
            <code className="break-all text-ink">{row.label}</code>
            <span className="text-ink-soft">{row.statusLabel}</span>
            <div className="flex w-full flex-wrap gap-x-3 gap-y-1 text-ink-muted">
              <span>カタログ: {yesNo(row.cataloged)}</span>
              <span>認証: {row.authenticated ? "済み" : "未認証"}</span>
              <span>利用可能: {yesNo(row.available)}</span>
              <span>whitelist: {row.inWhitelist ? "収載" : "対象外"}</span>
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
          <div
            key={row.provider}
            className="flex flex-wrap items-center justify-between gap-1 rounded-md bg-raised px-2.5 py-2 text-2xs"
          >
            <code className="break-all text-ink">{row.provider}</code>
            <span className="text-ink-soft">
              {row.authLabel} · {row.authSource}
            </span>
            <div className="flex w-full flex-wrap gap-x-3 gap-y-1 text-ink-muted">
              <span>カタログ: {row.catalogCount}</span>
              <span>whitelist 収載: {row.whitelistCount}</span>
              <span>利用可能: {row.availableCount}</span>
              {row.environmentVariables.map((name) => (
                <code key={name}>{name}</code>
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function ProviderDetails({ provider }: { provider: RuntimeProviderDisplayRow }) {
  return (
    <details open={provider.authLabel === "認証済み"} className="rounded-md border border-line bg-raised">
      <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-x-3 gap-y-1 px-2.5 py-2 text-2xs">
        <code className="break-all text-ink">{provider.provider}</code>
        <span className="text-ink-muted">
          {provider.authLabel} · カタログ {provider.catalogCount} · whitelist 収載 {provider.whitelistCount} · 利用可能{" "}
          {provider.availableCount}
        </span>
      </summary>
      <div className="grid gap-1 border-t border-line px-2.5 py-2">
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
        {provider.models.length === 0 ? (
          <p className="text-2xs text-ink-muted">このプロバイダーのカタログモデルはありません。</p>
        ) : (
          provider.models.map((model) => (
            <div
              key={model.id}
              className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1 rounded px-1 py-1 text-2xs"
            >
              <span className="min-w-0 break-all text-ink">
                {model.name} <code className="text-ink-muted">{model.id}</code>
              </span>
              <span className="shrink-0 text-ink-muted">
                利用可能: {yesNo(model.available)} · whitelist: {model.inWhitelist ? "収載" : "対象外"}
              </span>
            </div>
          ))
        )}
      </div>
    </details>
  );
}

function yesNo(value: boolean): string {
  return value ? "はい" : "いいえ";
}
