import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "../lib/cn";
import { getRuntimeEnvironment } from "../api";
import { useMessageCopy } from "../hooks/useMessageCopy";
import {
  createRuntimeReloadGate,
  HEALTH_RELOAD_FAILED_MESSAGE,
  reloadRuntime,
  RUNTIME_COMMANDS_EMPTY,
  RUNTIME_COMMANDS_FOOTNOTE,
  RUNTIME_COMMANDS_LOADING,
  RUNTIME_COMMANDS_UNAVAILABLE,
  RUNTIME_ENVIRONMENT_ERROR_LEAD,
  RUNTIME_ENVIRONMENT_LOADING,
  RUNTIME_SECTION_TITLES,
  runtimeCommandRows,
  runtimeConnectionRows,
  runtimeDiagnosticText,
  runtimeEnvironmentRows,
  runtimeEnvironmentStatusRow,
  runtimeFetchStateOf,
  runtimeVersionRows,
  type RuntimeFetchState,
  type RuntimeReloadGate,
} from "../lib/runtimeEnvironment";
import type { Health, RuntimeEnvironmentResponse, RuntimeEnvironmentState } from "../types";
import { CopyButton } from "./chat/CopyButton";
import { ReloadButton } from "./ReloadButton";
import { SettingsPageLayout, type SettingsPageProps } from "./SettingsPageLayout";
import { useRuntimeServe } from "../hooks/useRuntimeServe";
import { RuntimeServiceCard } from "./RuntimeServiceCard";

type RuntimePageProps = SettingsPageProps & {
  health: Health | null;
  /**
   * 親が持つ health の再取得。`isCurrent` を渡し、古い応答を親の state へ適用させない。
   * null (取得失敗 / キャンセル) は失敗として扱う。
   */
  onRefreshHealth: (isCurrent?: () => boolean) => Promise<Health | null>;
  onOpenSession?: (sessionId: string) => void;
};

/**
 * プロバイダー認証とカタログは 設定 → モデル が持つ。
 */
export function RuntimePage({
  health,
  onRefreshHealth,
  onOpenSession,
  compact = false,
  onBack,
  onOpenNav,
}: RuntimePageProps) {
  const service = useRuntimeServe();
  const [environmentState, setEnvironmentState] = useState<RuntimeFetchState<RuntimeEnvironmentResponse>>({
    status: "loading",
  });
  const [healthFailed, setHealthFailed] = useState(false);
  const [pending, setPending] = useState(true);
  const { copiedId, copyMessage } = useMessageCopy();
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

  const environment = environmentState.status === "ready" ? environmentState.value : undefined;
  const commandRows = environment?.state === "connected" ? runtimeCommandRows(environment.commands) : [];
  const diagnosticText = runtimeDiagnosticText({ health, healthFailed, environment: environmentState });

  return (
    <SettingsPageLayout
      eyebrow="RUNTIME"
      title="ランタイム"
      caption="接続状態・実行環境の診断と、公開中のサービスの確認・停止ができます。"
      actions={
        <>
          <CopyButton
            copied={copiedId === "diagnostic"}
            onClick={() => void copyMessage(diagnosticText, "diagnostic")}
            label="診断情報をコピー"
          />
          <ReloadButton
            onClick={() => {
              void runLoad(true);
              void service.refresh();
            }}
            disabled={pending}
          >
            再読み込み
          </ReloadButton>
        </>
      }
      compact={compact}
      onOpenNav={onOpenNav}
      onBack={onBack}
    >
      <div className="min-h-0 min-w-0 scrollbar-thin overflow-x-hidden overflow-y-auto px-4 py-4">
        <div className="mx-auto grid max-w-4xl gap-3">
          <RuntimeServiceCard
            state={service}
            hostname={location.hostname}
            port={health?.previewPort}
            onStop={() => void service.stop()}
            onOpenSession={onOpenSession}
          />
          <section className="grid gap-2 rounded-lg border border-line bg-soft p-3">
            <h3 className="text-2xs font-semibold tracking-label text-ink-faint uppercase">
              {RUNTIME_SECTION_TITLES.connection}
            </h3>
            {healthFailed ? (
              <p role="alert" className="text-2xs text-danger-text">
                {HEALTH_RELOAD_FAILED_MESSAGE}
              </p>
            ) : null}
            <dl className="grid gap-2 text-xs sm:grid-cols-2">
              {runtimeConnectionRows(health).map((row) => (
                <InfoItem key={row.label} {...row} />
              ))}
            </dl>
            <div className="grid gap-1 border-t border-line pt-2 text-2xs text-ink-muted">
              {runtimeVersionRows(health).map((row) => (
                <span key={row.label}>
                  {row.label}: {row.value}
                </span>
              ))}
            </div>
          </section>

          <section className="grid gap-2 rounded-lg border border-line bg-soft p-3">
            <h3 className="text-2xs font-semibold tracking-label text-ink-faint uppercase">
              {RUNTIME_SECTION_TITLES.environment}
            </h3>
            {environmentState.status === "loading" ? (
              <p role="status" className="text-xs text-ink-muted">
                {RUNTIME_ENVIRONMENT_LOADING}
              </p>
            ) : environmentState.status === "error" ? (
              <p role="alert" className="text-xs text-danger-text">
                {RUNTIME_ENVIRONMENT_ERROR_LEAD}
                {environmentState.message}
              </p>
            ) : environmentState.value.state === "connected" ? (
              <dl className="grid gap-2 text-xs sm:grid-cols-2">
                <EnvironmentStatusItem state="connected" />
                {runtimeEnvironmentRows(environmentState.value.environment, environmentState.value.landlock).map(
                  (row) => (
                    <InfoItem key={row.label} {...row} />
                  ),
                )}
              </dl>
            ) : (
              <EnvironmentStatusItem state={environmentState.value.state} />
            )}
          </section>

          <section className="grid gap-2 rounded-lg border border-line bg-soft p-3">
            <h3 className="text-2xs font-semibold tracking-label text-ink-faint uppercase">
              {RUNTIME_SECTION_TITLES.commands}
            </h3>
            {environmentState.status === "loading" ? (
              <p role="status" className="text-xs text-ink-muted">
                {RUNTIME_COMMANDS_LOADING}
              </p>
            ) : environmentState.status === "error" || environmentState.value.state !== "connected" ? (
              <p className="text-xs text-ink-muted">{RUNTIME_COMMANDS_UNAVAILABLE}</p>
            ) : commandRows.length === 0 ? (
              <p className="text-xs text-ink-muted">{RUNTIME_COMMANDS_EMPTY}</p>
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
                <p className="text-2xs text-ink-muted">{RUNTIME_COMMANDS_FOOTNOTE}</p>
              </>
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
  const row = runtimeEnvironmentStatusRow(state);
  return (
    <div className="grid min-w-0 gap-0.5">
      <dt className="text-2xs text-ink-faint">{row.label}</dt>
      <dd className="flex items-center gap-1.5 text-ink">
        <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", STATUS_TONE[row.tone])} />
        {row.value}
      </dd>
      {row.note ? <p className="text-2xs leading-relaxed text-ink-muted">{row.note}</p> : null}
    </div>
  );
}
