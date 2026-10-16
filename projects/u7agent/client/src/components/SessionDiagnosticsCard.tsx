/**
 * 設定 → ランタイム（`/settings/runtime/diagnostics`）のセッション診断カード。会話を 1 つ選び、サーバーのダンプと
 * このタブのクライアント状態を 1 つの JSON としてコピー / 生ログのダウンロードができる。
 *
 * 取得と操作の state は面（`DiagnosticsTab`）が持ち、このカードは渡された状態を描くだけにする。再読み込みは
 * 面のツールバーへ出し、対象と report をタブと共有するため（docs/diagnostics.md）。
 *
 * チャットが壊れていても (設定ページはチャットを mount したまま重ねる) ここから取れることを、
 * 「壊れた UI でも取れる」の本線にする (docs/diagnostics.md)。
 */
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
import type { SessionSummary } from "../types";
import { SelectMenu, type SelectMenuOption } from "./SelectMenu";

/** コピー / 生ログの失敗表示。`save` はコピーできなかった本文をファイルへ回す導線 */
export type SessionDiagnosticsFailure = {
  message: string;
  detail?: string;
  save?: { text: string; fileName: string };
};

export type SessionDiagnosticsCardProps = {
  /** 対象の会話の候補 (最終使用の新しい順) */
  sessions: SessionSummary[];
  /** このタブで開いている会話 (未選択は空文字) */
  openSessionId: string;
  /** 診断の対象 (未選択は空文字) */
  target: string;
  onSelectTarget: (sessionId: string) => void;
  report: DiagnosticsReport | null;
  /** 対象の取得中。対象が未選択のときは false */
  loading: boolean;
  /** コピー / 生ログの実行中 */
  busy: boolean;
  result: string;
  failure: SessionDiagnosticsFailure | null;
  onCopy: () => void;
  onDownloadRaw: () => void;
  onSaveText: (text: string, fileName: string) => void;
};

export function SessionDiagnosticsCard({
  sessions,
  openSessionId,
  target,
  onSelectTarget,
  report,
  loading,
  busy,
  result,
  failure,
  onCopy,
  onDownloadRaw,
  onSaveText,
}: SessionDiagnosticsCardProps) {
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

  return (
    <section className="grid gap-2 rounded-lg border border-line bg-soft p-3">
      <h3 className="text-2xs font-semibold tracking-label text-ink-faint uppercase">{DIAGNOSTICS_TITLE}</h3>
      <p className="text-xs leading-relaxed text-ink-muted">{DIAGNOSTICS_DESCRIPTION}</p>

      <div className="grid gap-2 sm:grid-cols-2">
        <SelectMenu label="対象の会話" options={options} value={target} onChange={onSelectTarget} />
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
        // ツールバーの [再読み込み] を押せない理由をここに出す
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
            <button type="button" className="btn-quiet" disabled={busy} onClick={onCopy}>
              {DIAGNOSTICS_COPY_LABEL}
            </button>
            <button type="button" className="btn-quiet" disabled={busy || !hasRawLog} onClick={onDownloadRaw}>
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
              onClick={() => onSaveText(save.text, save.fileName)}
            >
              ファイルとして保存
            </button>
          ) : null}
        </p>
      ) : null}
    </section>
  );
}
