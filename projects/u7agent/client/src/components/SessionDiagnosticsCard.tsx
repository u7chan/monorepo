/**
 * 設定 → ランタイム（`/settings/runtime`）のセッション診断カード。会話を 1 つ選び、サーバーのダンプと
 * このタブのクライアント状態を 1 つの JSON としてコピー / 生ログのダウンロードができる。
 *
 * チャットが壊れていても (設定ページはチャットを mount したまま重ねる) ここから取れることを、
 * 「壊れた UI でも取れる」の本線にする (docs/diagnostics.md)。
 */
import { useCallback, useEffect, useState } from "react";
import { useConfirm } from "./ConfirmProvider";
import { useDiagnostics } from "../DiagnosticsContext";
import { formatBytes } from "../lib/attachments";
import {
  DIAGNOSTICS_CLIENT_MISSING,
  DIAGNOSTICS_CLIENT_OPEN_BADGE,
  DIAGNOSTICS_COPY_LABEL,
  DIAGNOSTICS_DESCRIPTION,
  DIAGNOSTICS_FETCH_FAILED,
  DIAGNOSTICS_TITLE,
  RAW_LOG_LABEL,
  RAW_LOG_MISSING,
  RAW_LOG_NOTICE,
  diagnosticsCompareRows,
  diagnosticsResultLine,
  type DiagnosticsReport,
} from "../lib/diagnostics";
import { rawLogConfirmRequest } from "../lib/sidebarRowMenu";
import type { SessionSummary } from "../types";
import { ReloadButton } from "./ReloadButton";
import { SelectMenu, type SelectMenuOption } from "./SelectMenu";

export function SessionDiagnosticsCard({
  sessions,
  openSessionId,
}: {
  sessions: SessionSummary[];
  /** このタブで開いている会話 (未選択は空文字) */
  openSessionId: string;
}) {
  const diagnostics = useDiagnostics();
  const confirm = useConfirm();
  const [target, setTarget] = useState(openSessionId);
  const [report, setReport] = useState<DiagnosticsReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");
  const [failure, setFailure] = useState<{
    message: string;
    detail?: string;
    save?: { text: string; fileName: string };
  } | null>(null);

  const fetchReport = useCallback(
    async (sessionId: string): Promise<void> => {
      if (!sessionId) {
        setReport(null);
        return;
      }
      setLoading(true);
      setFailure(null);
      try {
        setReport(await diagnostics.buildReport(sessionId));
      } finally {
        setLoading(false);
      }
    },
    [diagnostics],
  );

  // 対象が変わったときだけ取得する (選択が空の間は何も取らない)
  useEffect(() => {
    void fetchReport(target);
  }, [target, fetchReport]);

  const openTitle = sessions.find((item) => item.sessionId === openSessionId)?.title || "無題のセッション";
  const options: SelectMenuOption[] = [
    ...(openSessionId
      ? [
          {
            value: openSessionId,
            label: openTitle,
            description: DIAGNOSTICS_CLIENT_OPEN_BADGE,
            group: "このタブで開いている会話",
          },
        ]
      : []),
    ...sessions
      .filter((item) => item.sessionId !== openSessionId)
      .map((item) => ({
        value: item.sessionId,
        label: item.title || "無題のセッション",
        description: item.agentName,
        group: "最近の会話",
      })),
  ];

  const summary = sessions.find((item) => item.sessionId === target);
  // サーバーのダンプが取れていればそちらを正にし、取れていないときは一覧の値で出し分ける
  const hasRawLog = report?.server?.raw.available ?? summary?.hasRawLog === true;
  const serverError = report?.serverError ?? null;
  const compareRows = report ? diagnosticsCompareRows(report.server, report.client) : [];
  const save = failure?.save;

  const copy = async (): Promise<void> => {
    setBusy(true);
    setResult("");
    setFailure(null);
    try {
      const outcome = await diagnostics.copy(target);
      setReport(outcome.report);
      if (outcome.ok) {
        setResult(`コピーしました（${diagnosticsResultLine(outcome.report)}）`);
        return;
      }
      setFailure({
        message: "クリップボードへコピーできませんでした",
        detail: outcome.detail,
        save: { text: outcome.text, fileName: outcome.fileName },
      });
    } finally {
      setBusy(false);
    }
  };

  const downloadRaw = async (): Promise<void> => {
    if (!(await confirm(rawLogConfirmRequest(summary?.title ?? "")))) return;
    setBusy(true);
    setResult("");
    setFailure(null);
    try {
      const outcome = await diagnostics.downloadRaw(target);
      if (outcome.ok) {
        setResult(`保存しました: ${outcome.fileName}（約 ${formatBytes(outcome.bytes)}）`);
        return;
      }
      setFailure({ message: "生ログを保存できませんでした", detail: outcome.detail });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="grid gap-2 rounded-lg border border-line bg-soft p-3">
      <header className="flex items-center justify-between gap-2">
        <h3 className="text-2xs font-semibold tracking-label text-ink-faint uppercase">{DIAGNOSTICS_TITLE}</h3>
        <ReloadButton onClick={() => void fetchReport(target)} disabled={!target || loading || busy}>
          再読み込み
        </ReloadButton>
      </header>
      <p className="text-xs leading-relaxed text-ink-muted">{DIAGNOSTICS_DESCRIPTION}</p>

      <div className="grid gap-2 sm:grid-cols-2">
        <SelectMenu label="対象の会話" options={options} value={target} onChange={setTarget} />
        <div className="flex items-end gap-2 pb-1">
          {target && target === openSessionId ? (
            <span className="rounded-full border border-accent/40 bg-accent-wash px-2 py-0.5 text-2xs text-accent-text">
              {DIAGNOSTICS_CLIENT_OPEN_BADGE}
            </span>
          ) : (
            <span className="text-2xs text-ink-faint">
              リロードで消える状態は、このタブで開いている会話だけ取れます
            </span>
          )}
        </div>
      </div>

      {!target ? (
        <p className="text-2xs text-ink-muted">対象の会話を選ぶまで取得しません。</p>
      ) : loading ? (
        <p role="status" className="text-xs text-ink-muted">
          診断情報を取得中…
        </p>
      ) : (
        <>
          {serverError ? (
            <p role="alert" className="text-xs text-danger-text">
              {DIAGNOSTICS_FETCH_FAILED}（{serverError}）
            </p>
          ) : null}
          {report?.client === null ? (
            <p className="text-2xs text-ink-muted">
              {report.clientUnavailable === "not-open"
                ? DIAGNOSTICS_CLIENT_MISSING
                : "クライアントの状態を取得できません"}
            </p>
          ) : null}
          {compareRows.length > 0 ? (
            <table className="w-full table-fixed border-collapse text-2xs">
              <caption className="sr-only">サーバーとクライアントの値の並記</caption>
              <thead>
                <tr className="text-3xs text-ink-muted">
                  <th scope="col" className="w-1/3 pr-2 pb-1 text-left font-medium">
                    項目
                  </th>
                  <th scope="col" className="w-1/3 pr-2 pb-1 text-left font-medium">
                    サーバー
                  </th>
                  <th scope="col" className="w-1/3 pb-1 text-left font-medium">
                    クライアント
                  </th>
                </tr>
              </thead>
              <tbody>
                {compareRows.map((row) => (
                  <tr key={row.label} className="border-t border-line/60 align-top">
                    <th scope="row" className="py-1 pr-2 text-left font-normal text-ink-faint">
                      {row.label}
                    </th>
                    <td className="py-1 pr-2 break-all text-ink-soft">{row.server}</td>
                    <td className="py-1 break-all text-ink-soft">{row.client}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          {report ? <p className="text-2xs break-words text-ink-faint">{diagnosticsResultLine(report)}</p> : null}

          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn-quiet" disabled={busy} onClick={() => void copy()}>
              {DIAGNOSTICS_COPY_LABEL}
            </button>
            <button
              type="button"
              className="btn-quiet"
              disabled={busy || !hasRawLog}
              onClick={() => void downloadRaw()}
            >
              {RAW_LOG_LABEL}
            </button>
          </div>
          {!hasRawLog ? <p className="text-2xs text-ink-muted">{RAW_LOG_MISSING}</p> : null}
        </>
      )}

      <details className="text-2xs leading-relaxed text-ink-muted">
        <summary className="cursor-pointer">生ログについて</summary>
        <p className="pt-1">{RAW_LOG_NOTICE}</p>
      </details>

      {result ? (
        <p role="status" className="text-2xs break-words text-ink-muted">
          {result}
        </p>
      ) : null}
      {failure ? (
        <p role="alert" className="grid gap-0.5 text-2xs text-danger-text">
          <span>{failure.message}</span>
          {failure.detail ? <span className="break-words text-ink-faint">{failure.detail}</span> : null}
          {save ? (
            <button
              type="button"
              className="justify-self-start underline"
              onClick={() => diagnostics.saveText(save.text, save.fileName)}
            >
              ファイルとして保存
            </button>
          ) : null}
        </p>
      ) : null}
    </section>
  );
}
