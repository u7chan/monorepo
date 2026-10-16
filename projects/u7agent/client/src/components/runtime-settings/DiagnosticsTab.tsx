import { useCallback, useEffect, useRef, useState } from "react";
import { useDiagnostics } from "../../DiagnosticsContext";
import { createLoadingTracker, createRequestGate } from "../../hooks/requestGate";
import { formatBytes } from "../../lib/attachments";
import { diagnosticsResultLine, rawLogConfirmRequest, type DiagnosticsReport } from "../../lib/diagnostics";
import type { SessionSummary } from "../../types";
import { useConfirm } from "../ConfirmProvider";
import { ReloadButton } from "../ReloadButton";
import { SessionDiagnosticsCard, type SessionDiagnosticsFailure } from "../SessionDiagnosticsCard";
import { RuntimeTabLayout, type RuntimeTabProps } from "./RuntimeTabLayout";

/**
 * 設定 → ランタイム の「診断」面。対象の会話と report は面のツールバーとカードが共有するためこのタブが持ち、
 * 取得もここで回す。コピー / 生ログの導線はカードに残し、押せない理由はカード内に 1 行で出す
 * (対象を選ぶまでツールバーの [再読み込み] は無効)。
 */
export function DiagnosticsTab({
  sessions,
  openSessionId,
  ...tabProps
}: RuntimeTabProps & {
  /** セッション診断の対象候補 (最終使用の新しい順) */
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
  const [failure, setFailure] = useState<SessionDiagnosticsFailure | null>(null);
  // 対象を切り替えた後に届いた旧応答を捨てる (遅い応答が新しい選択を上書きしない)
  const gateRef = useRef<ReturnType<typeof createRequestGate> | null>(null);
  if (gateRef.current === null) gateRef.current = createRequestGate();
  const gate = gateRef.current;
  // 取得中の表示は「最後に始まった要求」に紐づける。破棄した要求の完了が後続の進行中表示を消さない
  const loadingRef = useRef<ReturnType<typeof createLoadingTracker> | null>(null);
  if (loadingRef.current === null) loadingRef.current = createLoadingTracker(setLoading);
  const loadingTracker = loadingRef.current;

  const fetchReport = useCallback(
    async (sessionId: string): Promise<void> => {
      const isCurrent = gate();
      if (!sessionId) {
        setReport(null);
        return;
      }
      const finishLoading = loadingTracker.begin();
      // 選択が変わった時点で旧 report を失効させる (取得中に別の会話の値を出さない)
      setReport(null);
      setFailure(null);
      try {
        const next = await diagnostics.buildReport(sessionId);
        if (!isCurrent()) return;
        setReport(next);
      } finally {
        finishLoading();
      }
    },
    [diagnostics, gate, loadingTracker],
  );

  // 対象が変わったときだけ取得する (選択が空の間は何も取らない)
  useEffect(() => {
    void fetchReport(target);
  }, [target, fetchReport]);

  const copy = async (): Promise<void> => {
    const isCurrent = gate();
    setBusy(true);
    setResult("");
    setFailure(null);
    try {
      const outcome = await diagnostics.copy(target);
      if (!isCurrent()) return;
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
    const title = sessions.find((item) => item.sessionId === target)?.title ?? "";
    if (!(await confirm(rawLogConfirmRequest(title)))) return;
    const isCurrent = gate();
    setBusy(true);
    setResult("");
    setFailure(null);
    try {
      const outcome = await diagnostics.downloadRaw(target);
      if (!isCurrent()) return;
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
    <RuntimeTabLayout
      {...tabProps}
      actions={
        <ReloadButton onClick={() => void fetchReport(target)} disabled={!target || loading || busy}>
          再読み込み
        </ReloadButton>
      }
    >
      <div className="min-h-0 min-w-0 scrollbar-thin overflow-x-hidden overflow-y-auto px-4 py-4">
        <div className="mx-auto grid max-w-4xl gap-3">
          <SessionDiagnosticsCard
            sessions={sessions}
            openSessionId={openSessionId}
            target={target}
            onSelectTarget={setTarget}
            report={report}
            loading={loading}
            busy={busy}
            result={result}
            failure={failure}
            onCopy={() => void copy()}
            onDownloadRaw={() => void downloadRaw()}
            onSaveText={diagnostics.saveText}
          />
        </div>
      </div>
    </RuntimeTabLayout>
  );
}
