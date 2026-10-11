/**
 * 診断情報の入口。クライアント状態 (このタブの reducer と SSE の受信記録) と、サーバーのダンプ
 * (`GET /api/sessions/:id/diagnostics`) を 1 つの JSON にまとめ、コピー / ファイル保存 / 生ログの
 * 取得を提供する。画面は `DiagnosticsContext` 経由で使う。
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useSpaceApi } from "../SpaceContext";
import { clientBuildId } from "../lib/clientBuild";
import { copyToClipboard } from "../lib/copyToClipboard";
import {
  buildDiagnosticsReport,
  diagnosticsFileName,
  rawLogFileName,
  saveTextFile,
  type DiagnosticsRecorder,
  type DiagnosticsReport,
} from "../lib/diagnostics";
import type { SessionDiagnostics } from "../types";
import type { ChatState } from "./chatReducer";

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** コピーの結果。失敗しても `text` は捨てず、そのままファイル保存へ回せるようにする */
export type DiagnosticsCopyResult = {
  ok: boolean;
  /** コピーできなかった理由 (成功時は空) */
  detail: string;
  text: string;
  fileName: string;
  report: DiagnosticsReport;
};

export type RawLogResult = { ok: true; fileName: string; bytes: number } | { ok: false; detail: string };

export type SessionDiagnosticsApi = {
  /** 対象セッションの診断情報を 1 つの JSON に組み立てる (サーバーが落ちていてもクライアント分は返る) */
  buildReport: (sessionId: string) => Promise<DiagnosticsReport>;
  /** 組み立ててクリップボードへコピーする。失敗しても内容は返す */
  copy: (sessionId: string) => Promise<DiagnosticsCopyResult>;
  /** コピーに失敗した内容をファイルとして保存する */
  saveText: (text: string, fileName: string) => void;
  /** 生ログ (mask 前) を取得して保存する。開示の確認は呼び出し側が取る */
  downloadRaw: (sessionId: string) => Promise<RawLogResult>;
  /** `window.u7agentDebug.snapshot()` の実体。開いている会話のコピー用文字列を返す */
  snapshot: () => Promise<string>;
};

export function useSessionDiagnostics({
  chat,
  openSessionId,
  recorder,
}: {
  chat: ChatState;
  /** このタブで開いている会話。空文字は未選択 */
  openSessionId: string;
  recorder: DiagnosticsRecorder;
}): SessionDiagnosticsApi {
  const api = useSpaceApi();
  // 画面の操作は「押した瞬間」の状態で組む。state を依存に取ると、トークンのたびに参照が変わる
  const latest = useRef({ chat, openSessionId, recorder });
  latest.current = { chat, openSessionId, recorder };

  const buildReport = useCallback(
    async (sessionId: string): Promise<DiagnosticsReport> => {
      // 1 回のスナップショットは 1 時点。要求の前に chat / 選択 / recorder をまとめて控え、
      // 応答を待つ間のイベントで「取得が食い違いを作る」ことを防ぐ
      const moment = latest.current;
      const capturedAt = Date.now();
      const client = moment.recorder.capture();
      let server: SessionDiagnostics | null = null;
      let serverError: string | null = null;
      try {
        server = await api.getSessionDiagnostics(sessionId);
      } catch (error) {
        serverError = messageFor(error);
      }
      return buildDiagnosticsReport({
        sessionId,
        openSessionId: moment.openSessionId,
        chat: moment.chat,
        recorder: client,
        server,
        serverError,
        clientBuild: clientBuildId(),
        capturedAt,
      });
    },
    [api],
  );

  const copy = useCallback(
    async (sessionId: string): Promise<DiagnosticsCopyResult> => {
      const report = await buildReport(sessionId);
      const text = JSON.stringify(report, null, 2);
      const fileName = diagnosticsFileName(sessionId, report.capturedAt);
      try {
        await copyToClipboard(text);
        return { ok: true, detail: "", text, fileName, report };
      } catch (error) {
        return { ok: false, detail: messageFor(error), text, fileName, report };
      }
    },
    [buildReport],
  );

  const saveText = useCallback((text: string, fileName: string): void => {
    saveTextFile(text, fileName);
  }, []);

  const downloadRaw = useCallback(
    async (sessionId: string): Promise<RawLogResult> => {
      try {
        // 文字列化せず Blob のまま渡す (元のバイトを保持したまま保存する)
        const blob = await api.getSessionRawLog(sessionId);
        const fileName = rawLogFileName(sessionId, Date.now());
        saveTextFile(blob, fileName, "application/x-ndjson");
        return { ok: true, fileName, bytes: blob.size };
      } catch (error) {
        return { ok: false, detail: messageFor(error) };
      }
    },
    [api],
  );

  const snapshot = useCallback(async (): Promise<string> => {
    const { openSessionId: id } = latest.current;
    if (!id) {
      const current = latest.current;
      return JSON.stringify(
        buildDiagnosticsReport({
          sessionId: "",
          openSessionId: "",
          chat: current.chat,
          recorder: current.recorder.capture(),
          server: null,
          clientBuild: clientBuildId(),
        }),
        null,
        2,
      );
    }
    return JSON.stringify(await buildReport(id), null, 2);
  }, [buildReport]);

  useEffect(() => {
    window.u7agentDebug = { snapshot };
    return () => {
      // 別のインスタンスが登録した値を消さないよう、自分の参照だけを外す
      if (window.u7agentDebug?.snapshot === snapshot) delete window.u7agentDebug;
    };
  }, [snapshot]);

  return useMemo(
    () => ({ buildReport, copy, saveText, downloadRaw, snapshot }),
    [buildReport, copy, saveText, downloadRaw, snapshot],
  );
}
