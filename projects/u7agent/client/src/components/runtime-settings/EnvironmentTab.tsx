import { useCallback, useEffect, useRef, useState } from "react";
import { getRuntimeEnvironment, getRuntimeInUse } from "../../api";
import { useMessageCopy } from "../../hooks/useMessageCopy";
import { cn } from "../../lib/cn";
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
  RUNTIME_INTEGRATIONS_LOADING,
  RUNTIME_INTEGRATIONS_UNAVAILABLE,
  RUNTIME_MODELS_ERROR_LEAD,
  RUNTIME_MODELS_LOADING,
  RUNTIME_SECTION_TITLES,
  runtimeCommandRows,
  runtimeConnectionRows,
  runtimeDiagnosticText,
  runtimeEnvironmentRows,
  runtimeEnvironmentStatusRow,
  runtimeFetchStateOf,
  runtimeIntegrationRows,
  runtimeModelRows,
  runtimeVersionRows,
  type RuntimeFetchState,
  type RuntimeInfoRow,
  type RuntimeReloadGate,
} from "../../lib/runtimeEnvironment";
import type { Health, RuntimeEnvironmentResponse, RuntimeEnvironmentState, RuntimeInUseResponse } from "../../types";
import { CopyButton } from "../chat/CopyButton";
import { ReloadButton } from "../ReloadButton";
import { RuntimeTabLayout, type RuntimeTabProps } from "./RuntimeTabLayout";

/**
 * 設定 → ランタイム の「環境」面。接続状態・利用中のモデル・外部連携・実行環境・利用可能なコマンドは
 * 1 回の取得と「接続情報をコピー」の単位なので、1 面にまとめる。
 */
export function EnvironmentTab({
  health,
  onRefreshHealth,
  ...tabProps
}: RuntimeTabProps & {
  health: Health | null;
  onRefreshHealth: (isCurrent?: () => boolean) => Promise<Health | null>;
}) {
  const [inUseState, setInUseState] = useState<RuntimeFetchState<RuntimeInUseResponse>>({ status: "loading" });
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
        getInUse: getRuntimeInUse,
        getEnvironment: getRuntimeEnvironment,
      });
      // アンマウント / 再試行で古くなった応答は、失敗した系統の前回値を含めて何も適用しない
      if (!isCurrent()) return;
      if (results.health) setHealthFailed(!results.health.ok);
      // health と in-use は同じ再取得で揃えるが、片方の失敗でもう片方を捨てない
      setInUseState(runtimeFetchStateOf(results.inUse));
      setEnvironmentState(runtimeFetchStateOf(results.environment));
      setPending(false);
    },
    [gate, onRefreshHealth],
  );

  useEffect(() => {
    // 親が health を持つため、画面を開いたときは in-use と実行環境だけ取得する
    void runLoad(false);
    return () => gate.invalidate();
  }, [gate, runLoad]);

  return (
    <EnvironmentView
      {...tabProps}
      health={health}
      healthFailed={healthFailed}
      inUse={inUseState}
      environment={environmentState}
      pending={pending}
      onReload={() => void runLoad(true)}
    />
  );
}

export type EnvironmentViewProps = RuntimeTabProps & {
  health: Health | null;
  healthFailed: boolean;
  inUse: RuntimeFetchState<RuntimeInUseResponse>;
  environment: RuntimeFetchState<RuntimeEnvironmentResponse>;
  pending: boolean;
  onReload: () => void;
};

/**
 * 取得済みの状態だけを受け取る表示側。Effect を実行しない静的描画でも、行・コピーボタン・
 * 失敗文言をそのまま固定できるように取得から切り離す。
 */
export function EnvironmentView({
  health,
  healthFailed,
  inUse,
  environment,
  pending,
  onReload,
  ...tabProps
}: EnvironmentViewProps) {
  const { copiedId, copyMessage, copyFailure } = useMessageCopy();
  const commandRows =
    environment.status === "ready" && environment.value.state === "connected"
      ? runtimeCommandRows(environment.value.commands)
      : [];
  const diagnosticText = runtimeDiagnosticText({ health, healthFailed, inUse, environment });

  const infoItems = (rows: RuntimeInfoRow[]) =>
    rows.map((row) => (
      <InfoItem key={row.label} row={row} copiedId={copiedId} copyFailure={copyFailure} onCopy={copyMessage} />
    ));

  return (
    <RuntimeTabLayout
      {...tabProps}
      actions={
        <>
          <CopyButton
            copied={copiedId === "diagnostic"}
            failure={copyFailure("diagnostic")}
            onClick={() => void copyMessage(diagnosticText, "diagnostic")}
            label="接続情報をコピー"
          />
          <ReloadButton onClick={onReload} disabled={pending}>
            再読み込み
          </ReloadButton>
        </>
      }
    >
      <div className="min-h-0 min-w-0 scrollbar-thin overflow-x-hidden overflow-y-auto px-4 py-4">
        <div className="mx-auto grid max-w-4xl gap-3">
          <section className="grid gap-2 rounded-lg border border-line bg-soft p-3">
            <h3 className="text-2xs font-semibold tracking-label text-ink-faint uppercase">
              {RUNTIME_SECTION_TITLES.connection}
            </h3>
            {healthFailed ? (
              <p role="alert" className="text-2xs text-danger-text">
                {HEALTH_RELOAD_FAILED_MESSAGE}
              </p>
            ) : null}
            <dl className="grid gap-2 text-xs sm:grid-cols-2">{infoItems(runtimeConnectionRows(health))}</dl>
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
              {RUNTIME_SECTION_TITLES.models}
            </h3>
            {inUse.status === "loading" ? (
              <p role="status" className="text-xs text-ink-muted">
                {RUNTIME_MODELS_LOADING}
              </p>
            ) : inUse.status === "error" ? (
              <p role="alert" className="text-xs text-danger-text">
                {RUNTIME_MODELS_ERROR_LEAD}
                {inUse.message}
              </p>
            ) : (
              <dl className="grid gap-2 text-xs sm:grid-cols-2">{infoItems(runtimeModelRows(health, inUse.value))}</dl>
            )}
          </section>

          <section className="grid gap-2 rounded-lg border border-line bg-soft p-3">
            <h3 className="text-2xs font-semibold tracking-label text-ink-faint uppercase">
              {RUNTIME_SECTION_TITLES.integrations}
            </h3>
            {inUse.status === "loading" ? (
              <p role="status" className="text-xs text-ink-muted">
                {RUNTIME_INTEGRATIONS_LOADING}
              </p>
            ) : inUse.status === "error" ? (
              <p className="text-xs text-ink-muted">{RUNTIME_INTEGRATIONS_UNAVAILABLE}</p>
            ) : (
              <dl className="grid gap-2 text-xs sm:grid-cols-2">{infoItems(runtimeIntegrationRows(inUse.value))}</dl>
            )}
          </section>

          <section className="grid gap-2 rounded-lg border border-line bg-soft p-3">
            <h3 className="text-2xs font-semibold tracking-label text-ink-faint uppercase">
              {RUNTIME_SECTION_TITLES.environment}
            </h3>
            {environment.status === "loading" ? (
              <p role="status" className="text-xs text-ink-muted">
                {RUNTIME_ENVIRONMENT_LOADING}
              </p>
            ) : environment.status === "error" ? (
              <p role="alert" className="text-xs text-danger-text">
                {RUNTIME_ENVIRONMENT_ERROR_LEAD}
                {environment.message}
              </p>
            ) : environment.value.state === "connected" ? (
              <dl className="grid gap-2 text-xs sm:grid-cols-2">
                <EnvironmentStatusItem state="connected" />
                {infoItems(runtimeEnvironmentRows(environment.value.environment, environment.value.landlock))}
              </dl>
            ) : (
              <EnvironmentStatusItem state={environment.value.state} />
            )}
          </section>

          <section className="grid gap-2 rounded-lg border border-line bg-soft p-3">
            <h3 className="text-2xs font-semibold tracking-label text-ink-faint uppercase">
              {RUNTIME_SECTION_TITLES.commands}
            </h3>
            {environment.status === "loading" ? (
              <p role="status" className="text-xs text-ink-muted">
                {RUNTIME_COMMANDS_LOADING}
              </p>
            ) : environment.status === "error" || environment.value.state !== "connected" ? (
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
    </RuntimeTabLayout>
  );
}

/** コピーの識別子。行のラベルは画面内で重複しないため、そのまま id に使う */
function copyIdOf(row: RuntimeInfoRow): string {
  return `copy:${row.label}`;
}

function noteCopyIdOf(row: RuntimeInfoRow): string {
  return `note:${row.label}`;
}

function InfoItem({
  row,
  copiedId,
  copyFailure,
  onCopy,
}: {
  row: RuntimeInfoRow;
  copiedId: string;
  copyFailure: (id: string) => string | undefined;
  onCopy: (text: string, id: string) => void;
}) {
  const copy = row.copy;
  const noteCopy = row.noteCopy;
  return (
    <div className="grid min-w-0 gap-0.5">
      <dt className="text-2xs text-ink-faint">{row.label}</dt>
      <dd className="flex min-w-0 items-center gap-1 text-ink">
        <span className="min-w-0 break-all">{row.value}</span>
        {copy ? (
          <CopyButton
            copied={copiedId === copyIdOf(row)}
            failure={copyFailure(copyIdOf(row))}
            onClick={() => onCopy(copy.text, copyIdOf(row))}
            label={copy.label}
            compact
          />
        ) : null}
      </dd>
      {row.note ? (
        <p className="flex min-w-0 items-center gap-1 text-2xs leading-relaxed text-ink-muted">
          <span className="break-all">{row.note}</span>
          {noteCopy ? (
            <CopyButton
              copied={copiedId === noteCopyIdOf(row)}
              failure={copyFailure(noteCopyIdOf(row))}
              onClick={() => onCopy(noteCopy.text, noteCopyIdOf(row))}
              label={noteCopy.label}
              compact
            />
          ) : null}
        </p>
      ) : null}
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
