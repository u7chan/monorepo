import { useEffect, useState } from "preact/hooks";
import type { CodexAuthState, CodexProbeConfig, ProbeCheckOutcome, UsageSource } from "../api";
import { showsSignOutButton } from "../lib/codex-signin";
import { canStartCodexWindow, probeErrorMessage } from "../lib/probe";
import { CodexAuthPanel, type CodexActions } from "./CodexAuthPanel";
import { OverflowMenu, type MenuItem } from "./OverflowMenu";
import { ProviderCard } from "./ProviderCard";

/** Codex カード 1 枚ぶん。サインアウトは見出しのメニュー、サインインの進行はカードの中に出す。 */
export function CodexCard(props: {
  source: UsageSource;
  now: number;
  generatedAt: number | null;
  compact?: boolean;
  auth: CodexAuthState | null;
  actions: CodexActions;
  /** 送信の設定。未設定なら開始ボタンを出さない。 */
  probe: CodexProbeConfig | null;
  onCheck: () => Promise<ProbeCheckOutcome>;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkMessage, setCheckMessage] = useState<string | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const needsSignIn = props.source.error?.code === "not_connected" || props.source.error?.code === "reauth_required";
  const loginStatus = props.auth?.login?.status ?? null;

  // サインインを始めたら、前回のサインアウト失敗はもう関係ない。
  useEffect(() => {
    if (loginStatus !== null) {
      setMessage(null);
    }
  }, [loginStatus]);

  const showSignOut = showsSignOutButton({
    known: props.auth !== null,
    needsSignIn,
    signedIn: props.auth?.signedIn ?? false,
    loginStatus,
  });

  const signOut = async (): Promise<void> => {
    setBusy(true);
    setMessage(null);

    try {
      const ok = await props.actions.onLogout();

      if (!ok) {
        setMessage("サインアウトできませんでした。もう一度試してください。");
      }
    } catch {
      setMessage("通信に失敗しました。もう一度試してください。");
    } finally {
      setBusy(false);
    }
  };

  const items: MenuItem[] = showSignOut
    ? [{ label: "サインアウト", onSelect: () => void signOut(), disabled: busy, danger: true }]
    : [];

  const canStart = canStartCodexWindow({
    configured: props.probe !== null,
    signedIn: props.auth?.signedIn ?? false,
    source: props.source,
    running: checking,
  });

  const start = async (): Promise<void> => {
    setChecking(true);
    setCheckMessage(null);
    setCheckError(null);

    try {
      const outcome = await props.onCheck();

      if (outcome.ok) {
        // 反映が遅れることがある。取得できたときだけリセット時刻が出る、という前提の文言にする。
        setCheckMessage(`送信しました（${outcome.latencyMs} ms）。利用枠を再取得しています…`);
      } else {
        setCheckError(probeErrorMessage(outcome.error));
      }
    } catch {
      setCheckError(probeErrorMessage("unavailable"));
    } finally {
      setChecking(false);
    }
  };

  const footerAction =
    props.probe === null ? undefined : (
      <div class="up-probe">
        <button class="up-button" type="button" disabled={!canStart} onClick={() => void start()}>
          {checking ? "送信中…" : "5時間を開始"}
        </button>
        {checkMessage ? (
          <p class="up-caption" role="status">
            {checkMessage}
          </p>
        ) : null}
        {checkError ? (
          <p class="up-error" role="alert">
            {checkError}
          </p>
        ) : null}
      </div>
    );

  return (
    <ProviderCard
      source={props.source}
      now={props.now}
      generatedAt={props.generatedAt}
      compact={props.compact}
      headerMenu={items.length > 0 ? <OverflowMenu label="Codex の操作" items={items} /> : undefined}
      footerAction={footerAction}
    >
      <CodexAuthPanel auth={props.auth} actions={props.actions} needsSignIn={needsSignIn} message={message} />
    </ProviderCard>
  );
}
