/**
 * 診断の入口 (`DiagnosticsContext`) を要求する部品を SSR で描くテスト用のスタブ。
 * コピー / 生ログの結果はここでは扱わず、呼ばれたら失敗させる (押下の検証は各テストが行う)。
 */
import type { SessionDiagnosticsApi } from "../src/hooks/useSessionDiagnostics";

export const diagnosticsStub = {
  buildReport: async () => {
    throw new Error("スタブでは診断情報を取得しない");
  },
  copy: async () => {
    throw new Error("スタブでは診断情報をコピーしない");
  },
  saveText: () => {},
  downloadRaw: async () => ({ ok: false, detail: "スタブでは生ログを取らない" }),
  snapshot: async () => "",
} as unknown as SessionDiagnosticsApi;
