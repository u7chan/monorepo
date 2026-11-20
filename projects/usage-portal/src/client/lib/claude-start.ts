import type { ClaudeStartRun, ClaudeStartRunOutcome, ClaudeStartState } from "../api";
import { CLAUDE_START_MAX_FAILURES, CLAUDE_START_WINDOW_MINUTES } from "../../shared/claude-start";
import { formatClock, formatDateTime } from "./format";

const WINDOW_MS = CLAUDE_START_WINDOW_MINUTES * 60_000;

/** 見送り・失敗の理由。サーバーの固定コードだけを訳し、知らないコードは一般的な文言に寄せる。 */
export function claudeStartReason(code: string | null): string {
  switch (code) {
    case "active":
      return "窓が動いていた";
    case "session_limit":
      return "5 時間の上限に達していた";
    case "weekly_limit":
      return "週次の上限に達していた";
    case "limit_reached":
      return "上限に達していた";
    case "missed":
      return "時刻を過ぎていた（サーバー停止）";
    case "reauth_required":
      return "再ログインが必要";
    case "not_connected":
      return "サインインしていない";
    case "subscription_required":
      return "Pro / Max でのサインインが必要";
    case "model_unavailable":
      return "モデルを使えない";
    case "timeout":
      return "時間内に終わらなかった";
    case "config":
      return "Claude の CLI を実行できない";
    default:
      return "Claude に送れなかった";
  }
}

export type ClaudeStartTone = "ok" | "skip" | "fail";

/** 履歴の 1 行。結果の語と、理由または送信時刻の補足。 */
export function describeClaudeStartRun(run: ClaudeStartRun): { tone: ClaudeStartTone; label: string; detail: string } {
  const kind = run.kind === "manual" ? "今すぐ開始・" : "";

  switch (run.outcome) {
    case "ok":
      return { tone: "ok", label: "成功", detail: `${kind}${formatClock(run.ranAt)} に送信` };
    case "skipped": {
      const reset = run.resetsAt === null ? "" : `（${formatClock(run.resetsAt)} にリセット）`;

      return { tone: "skip", label: "見送り", detail: `${kind}${claudeStartReason(run.code)}${reset}` };
    }
    default:
      return { tone: "fail", label: "失敗", detail: `${kind}${claudeStartReason(run.code)}` };
  }
}

/** カードのフッターの 1 行。予約が有効か、失敗で止まったときだけ出す。 */
export function claudeStartFooter(
  state: ClaudeStartState | null,
): { tone: "normal" | "attention" | "danger"; text: string } | null {
  if (state === null || state.settings === null) {
    return null;
  }

  if (!state.enabled) {
    return state.stoppedCode === null
      ? null
      : { tone: "danger", text: `開始予約を停止中（${CLAUDE_START_MAX_FAILURES} 回続けて失敗）` };
  }

  if (state.failures > 0) {
    const last = state.runs.find((run) => run.kind === "auto" && run.outcome === "failed") ?? null;

    return {
      tone: "attention",
      text: `開始に失敗（${claudeStartReason(last?.code ?? null)}）${state.failures}/${CLAUDE_START_MAX_FAILURES}`,
    };
  }

  if (state.nextStartAt === null) {
    return null;
  }

  return {
    tone: "normal",
    text: `次の開始 ${formatDateTime(state.nextStartAt)} → ${formatClock(state.nextStartAt + WINDOW_MS)} リセット`,
  };
}

/** 「今すぐ開始」の結果の文言。 */
export function claudeStartRunMessage(result: ClaudeStartRunOutcome): { failed: boolean; text: string } {
  switch (result.outcome) {
    case "ok":
      return {
        failed: false,
        text:
          result.resetsAt === null
            ? "5 時間の利用枠を開始しました。"
            : `5 時間の利用枠を開始しました。${formatClock(result.resetsAt)} にリセットされます。`,
      };
    case "skipped":
      return { failed: false, text: `送りませんでした（${claudeStartReason(result.code)}）。` };
    case "failed":
      return { failed: true, text: `開始できませんでした（${claudeStartReason(result.code)}）。` };
    default:
      return {
        failed: true,
        text:
          result.error === "in_progress"
            ? "予約の実行中です。終わってから試してください。"
            : "開始できませんでした。もう一度試してください。",
      };
  }
}
