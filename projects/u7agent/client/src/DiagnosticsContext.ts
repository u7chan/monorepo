/**
 * 診断情報の操作を、サイドバーの会話行と設定 → ランタイムのカードの両方へ配る。
 * facade (`useSessionDiagnostics`) を props で 3 段 (Sidebar → ProjectRow → SessionList → SessionRow)
 * 下ろさずに済ませるため、SpaceContext と同じく文脈で渡す。
 */
import { createContext, useContext } from "react";
import type { SessionDiagnosticsApi } from "./hooks/useSessionDiagnostics";

export const DiagnosticsContext = createContext<SessionDiagnosticsApi | null>(null);

export function useDiagnostics(): SessionDiagnosticsApi {
  const context = useContext(DiagnosticsContext);
  if (!context) throw new Error("診断情報の入口が用意されていません");
  return context;
}
