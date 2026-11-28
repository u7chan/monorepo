import { useState } from "preact/hooks";
import type { GeminiRefreshOutcome, UsageSource } from "../api";
import {
  GEMINI_CREDENTIAL_DIR_NOTE,
  GEMINI_LOGIN_COMMAND,
  GEMINI_SCOPE_NOTE,
  geminiRefreshMessage,
  geminiStatusLabel,
} from "../lib/gemini";

/**
 * カードが無いときの Gemini の入口。状態とサインインの手順を出し、確認だけをここから起こす。
 * サインインは中継しない（docs/adr/gemini-integration.md）。
 */
export function GeminiSettingsPanel(props: {
  source: UsageSource;
  onRefresh: () => Promise<GeminiRefreshOutcome | null>;
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

      setMessage(geminiRefreshMessage(outcome));
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
      <p class="up-caption">状態: {checking ? "確認しています…" : geminiStatusLabel(props.source)}</p>
      <p class="up-caption">{GEMINI_SCOPE_NOTE}</p>
      <p class="up-caption">
        Gemini のサインインは Web UI
        では行いません。端末で次のコマンドを実行し、表示される手順でサインインしてから「接続を確認」を押してください。
      </p>
      <div class="up-gemini-command">
        <code class="up-code-string">{GEMINI_LOGIN_COMMAND}</code>
      </div>
      <p class="up-caption">{GEMINI_CREDENTIAL_DIR_NOTE}</p>
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
