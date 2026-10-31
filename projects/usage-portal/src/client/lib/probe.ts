import type { UsageSource } from "../api";

/**
 * 「5時間を開始」を押せるか。5h 窓が API に出ないアカウントがあるため、
 * 「開始済み」は判定しない。押しても窓は延びないので、迷ったら押せる側に倒す。
 */
export function canStartCodexWindow(input: {
  configured: boolean;
  signedIn: boolean;
  source: Pick<UsageSource, "state" | "windows" | "limitReached"> | null;
  running: boolean;
}): boolean {
  if (!input.configured || !input.signedIn || input.running) {
    return false;
  }

  const source = input.source;

  // 取得前は窓が無く、上流が使えるかも分からない。
  if (source === null || (source.state !== "ok" && source.state !== "stale")) {
    return false;
  }

  if (source.windows.length === 0 || source.limitReached) {
    return false;
  }

  // 週次しか返らないアカウントでは、その 100% が「もう使えない」を意味する。
  return source.windows.every((window) => window.usedPercent < 100);
}

const PROBE_ERRORS: Record<string, string> = {
  not_configured: "送信の設定がありません。メニューから設定してください。",
  in_progress: "送信中です。完了までお待ちください。",
  reauth_required: "Codex にサインインし直してください。",
  invalid_key: "API キーが受け付けられませんでした。キーを登録し直してください。",
  limit_reached: "利用枠の上限に達しています。リセット後に試してください。",
  model_unavailable: "設定したモデルを使えません。設定を見直してください。",
  invalid_thinking: "設定した思考レベルを使えません。設定を見直してください。",
  invalid_model: "選んだモデルを使えません。設定を見直してください。",
  unauthorized: "セッションが切れました。もう一度 PIN を入力してください。",
  unavailable: "送信できませんでした。通信を確かめて、もう一度試してください。",
};

/** 失敗は固定文言へ寄せる。上流の本文も例外文も画面に出さない。 */
export function probeErrorMessage(error: string): string {
  return PROBE_ERRORS[error] ?? "送信できませんでした。もう一度試してください。";
}
