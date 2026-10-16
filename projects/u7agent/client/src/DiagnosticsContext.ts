/**
 * 診断情報の操作を、設定 → ランタイムの診断タブのカードへ配る。facade (`useSessionDiagnostics`) は
 * `useU7Agent` が 1 つだけ作るため、設定画面まで props で下ろさずに済ませる (SpaceContext と同じく文脈で渡す)。
 */
import { createContext, useContext } from "react";
import type { SessionDiagnosticsApi } from "./hooks/useSessionDiagnostics";

export const DiagnosticsContext = createContext<SessionDiagnosticsApi | null>(null);

export function useDiagnostics(): SessionDiagnosticsApi {
  const context = useContext(DiagnosticsContext);
  if (!context) throw new Error("診断情報の入口が用意されていません");
  return context;
}
