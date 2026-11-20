import { useCallback, useEffect, useState } from "preact/hooks";
import {
  fetchClaudeStart,
  runClaudeStart,
  saveClaudeStart,
  setClaudeStartEnabled,
  type ClaudeRefreshOutcome,
  type ClaudeStartState,
  type ClaudeStartUpdate,
  type UsageSource,
} from "../api";
import { CLAUDE_API_KEY_HELPER_NOTE, CLAUDE_LOGIN_COMMAND, claudeRefreshMessage } from "../lib/claude";
import { claudeStartFooter, claudeStartRunMessage } from "../lib/claude-start";
import { ClaudeStartPanel, type ClaudeStartTab } from "./ClaudeStartPanel";
import { Modal } from "./Modal";
import { OverflowMenu, type MenuItem } from "./OverflowMenu";
import { ProviderCard } from "./ProviderCard";

/** 予約の時刻や結果はサーバーの timer で変わる。利用枠の取得と同じ 60 秒で読み直す。 */
const START_POLL_MS = 60_000;

const FALLBACK_ERROR = "通信に失敗しました。もう一度試してください。";

/**
 * Claude カード 1 枚ぶん。周期取得が無いので、取り直す入口は見出しのメニューと、
 * 未接続のときの案内にだけ置く。ログアウトはカードを消す操作なので、確認はカードの中で行う。
 */
export function ClaudeCard(props: {
  source: UsageSource;
  now: number;
  generatedAt: number | null;
  compact?: boolean;
  onRefresh: () => Promise<ClaudeRefreshOutcome | null>;
  onLogout: () => Promise<boolean>;
  /** 開始の送信で利用枠が変わったときに、カードの値を読み直す。 */
  onUsageChanged: () => Promise<unknown>;
  onUnauthorized: () => void;
}) {
  const { onUnauthorized } = props;
  const [start, setStart] = useState<ClaudeStartState | null>(null);
  const [startTab, setStartTab] = useState<ClaudeStartTab | null>(null);
  const [starting, setStarting] = useState(false);

  const loadStart = useCallback(async (): Promise<void> => {
    try {
      const result = await fetchClaudeStart();

      if (result !== null && "unauthorized" in result) {
        onUnauthorized();
      } else if (result !== null) {
        setStart(result);
      }
    } catch {
      // 読めなかったときは前回の値を残す。フッターの 1 行が一時的に古いだけで、操作は止めない。
    }
  }, [onUnauthorized]);

  useEffect(() => {
    void loadStart();

    const timer = setInterval(() => void loadStart(), START_POLL_MS);

    return () => clearInterval(timer);
  }, [loadStart]);

  const applyStart = async (request: Promise<ClaudeStartUpdate>): Promise<string | null> => {
    const result = await request;

    if (!result.ok) {
      if (result.error === "unauthorized") {
        onUnauthorized();
      }

      return result.error;
    }

    setStart(result.state);

    return null;
  };

  const startNow = async (): Promise<void> => {
    setStarting(true);
    setMessage(null);

    try {
      const result = await runClaudeStart();

      if (result.outcome === "error" && result.error === "unauthorized") {
        onUnauthorized();

        return;
      }

      const described = claudeStartRunMessage(result);

      setMessage(described.text);
      setFailed(described.failed);
      await Promise.all([loadStart(), props.onUsageChanged()]);
    } catch {
      setMessage(FALLBACK_ERROR);
      setFailed(true);
    } finally {
      setStarting(false);
    }
  };

  const [refreshing, setRefreshing] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const refresh = async (): Promise<void> => {
    setRefreshing(true);
    setMessage(null);

    try {
      const outcome = await props.onRefresh();

      setMessage(claudeRefreshMessage(outcome));
      setFailed(outcome === null || outcome.state === "failed");
    } catch {
      setMessage(FALLBACK_ERROR);
      setFailed(true);
    } finally {
      setRefreshing(false);
    }
  };

  const logout = async (): Promise<void> => {
    setLoggingOut(true);
    setMessage(null);

    try {
      const ok = await props.onLogout();

      // 成功するとカードは predicate で消える。残るのは、設定ファイル由来の認証が戻る場合だけ。
      if (ok) {
        setConfirming(false);
      } else {
        setMessage("ログアウトできませんでした。もう一度試してください。");
        setFailed(true);
      }
    } catch {
      setMessage(FALLBACK_ERROR);
      setFailed(true);
    } finally {
      setLoggingOut(false);
    }
  };

  const busy = refreshing || loggingOut || starting;
  const footer = claudeStartFooter(start);
  const items: MenuItem[] = [
    { label: "更新", onSelect: () => void refresh(), disabled: busy },
    { label: "開始予約…", onSelect: () => setStartTab("plan"), disabled: start === null },
    {
      label: "今すぐ開始",
      onSelect: () => void startNow(),
      disabled: busy || start === null || start.settings === null || start.running,
    },
    {
      label: "ログアウトして非表示",
      onSelect: () => {
        setConfirming(true);
        setMessage(null);
      },
      disabled: busy,
      danger: true,
    },
  ];

  return (
    <ProviderCard
      source={props.source}
      now={props.now}
      generatedAt={props.generatedAt}
      compact={props.compact}
      headerMenu={<OverflowMenu label="Claude の操作" items={items} />}
    >
      {footer === null ? null : footer.tone === "normal" ? (
        <p class="up-caption up-start-footer">{footer.text}</p>
      ) : (
        <button
          type="button"
          class={`up-start-footer up-start-footer-${footer.tone}`}
          onClick={() => setStartTab("log")}
        >
          ⚠ {footer.text}
        </button>
      )}

      {startTab !== null && start !== null ? (
        <Modal title="Claude の開始予約" onClose={() => setStartTab(null)}>
          {(close) => (
            <ClaudeStartPanel
              state={start}
              initialTab={startTab}
              onSave={(settings) => applyStart(saveClaudeStart(settings))}
              onToggle={(enabled) => applyStart(setClaudeStartEnabled(enabled))}
              onClose={close}
            />
          )}
        </Modal>
      ) : null}

      {starting ? (
        <p class="up-caption" role="status">
          5 時間の利用枠を開始しています…
        </p>
      ) : refreshing ? (
        <p class="up-caption" role="status">
          更新しています…
        </p>
      ) : message === null ? null : (
        <p class={failed ? "up-error" : "up-caption"} role={failed ? "alert" : "status"}>
          {message}
        </p>
      )}

      {confirming ? (
        <section class="up-claude">
          <p class="up-caption">
            この端末の Claude の資格情報を CLI
            で削除し、カードを隠します。サインインし直すまで表示されません。利用枠の推移は残ります。
          </p>
          <div class="up-form-actions">
            <button class="up-button up-button-secondary" type="button" disabled={busy} onClick={() => void logout()}>
              ログアウトする
            </button>
            <button
              class="up-button up-button-secondary"
              type="button"
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              やめる
            </button>
          </div>
        </section>
      ) : null}

      <SignInHelp source={props.source} />
    </ProviderCard>
  );
}

/** サインインは Web UI で中継せず、端末で 1 回だけ行う。ここには手順だけを出す。 */
function SignInHelp(props: { source: UsageSource }) {
  const code = props.source.error?.code ?? null;
  const lead = signInLead(code);

  if (lead === null) {
    return null;
  }

  return (
    <section class="up-claude">
      <p class="up-caption">{lead}</p>
      <div class="up-claude-command">
        <code class="up-code-string">{CLAUDE_LOGIN_COMMAND}</code>
      </div>
      {code === "subscription_required" ? <p class="up-caption">{CLAUDE_API_KEY_HELPER_NOTE}</p> : null}
      <p class="up-caption">サインインは Web UI では行いません。サインイン後に「更新」で取得します。</p>
    </section>
  );
}

function signInLead(code: string | null): string | null {
  switch (code) {
    case "not_connected":
      return "Claude にサインインしていません。端末で次のコマンドを実行してサインインしてください。";
    case "reauth_required":
      return "サインインの期限が切れています。端末で次のコマンドを実行してサインインし直してください。";
    case "subscription_required":
      return "Claude の Pro / Max でのサインインが必要です。端末で次のコマンドを実行し、サブスクリプションのアカウントでサインインしてください。";
    default:
      return null;
  }
}
