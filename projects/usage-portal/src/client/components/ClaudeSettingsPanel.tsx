import { useState } from "preact/hooks";
import type { ClaudeRefreshOutcome, UsageSource } from "../api";
import {
  CLAUDE_API_KEY_HELPER_NOTE,
  CLAUDE_LOGIN_COMMAND,
  claudeRefreshMessage,
  claudeStatusLabel,
} from "../lib/claude";

/**
 * カードが無いときの Claude の入口。状態とサインインの手順を出し、確認だけをここから起こす。
 * ログインは中継しない（ADR 0022）。
 */
export function ClaudeSettingsPanel(props: {
  source: UsageSource;
  onRefresh: () => Promise<ClaudeRefreshOutcome | null>;
  onClose: () => void;
}) {
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const check = async (): Promise<void> => {
    setChecking(true);
    setMessage(null);

    try {
      const outcome = await props.onRefresh();

      setMessage(claudeRefreshMessage(outcome));
      setFailed(outcome === null || outcome.state === "failed");
    } catch {
      setMessage("通信に失敗しました。もう一度試してください。");
      setFailed(true);
    } finally {
      setChecking(false);
    }
  };

  return (
    <div class="up-form">
      <p class="up-caption">状態: {checking ? "確認しています…" : claudeStatusLabel(props.source)}</p>
      <p class="up-caption">
        Claude のサインインは Web UI では行いません。端末で次のコマンドを実行してから「接続を確認」を押してください。
      </p>
      <div class="up-claude-command">
        <code class="up-code-string">{CLAUDE_LOGIN_COMMAND}</code>
      </div>
      {props.source.error?.code === "subscription_required" ? (
        <p class="up-caption">{CLAUDE_API_KEY_HELPER_NOTE}</p>
      ) : null}
      {message === null ? null : (
        <p class={failed ? "up-error" : "up-caption"} role={failed ? "alert" : "status"}>
          {message}
        </p>
      )}
      <div class="up-form-actions">
        <button class="up-button" type="button" disabled={checking} onClick={() => void check()}>
          接続を確認
        </button>
        <button class="up-button up-button-secondary" type="button" disabled={checking} onClick={props.onClose}>
          閉じる
        </button>
      </div>
    </div>
  );
}
