import { useCallback, useEffect, useState } from "preact/hooks";
import {
  ApiError,
  describeError,
  fetchSession,
  fetchState,
  logout as logoutRequest,
  type SessionState,
  type StatePayload,
} from "./api";
import { ConnectionsPanel } from "./components/ConnectionsPanel";
import { KeysPanel } from "./components/KeysPanel";
import { LoginScreen } from "./components/LoginScreen";
import { RunsPanel } from "./components/RunsPanel";

type Tab = "connections" | "keys" | "runs";

const TAB_LABELS: Record<Tab, string> = {
  connections: "接続先",
  keys: "API キー",
  runs: "実行履歴",
};

export function App() {
  const [session, setSession] = useState<SessionState | null>(null);
  const [payload, setPayload] = useState<StatePayload | null>(null);
  const [tab, setTab] = useState<Tab>("connections");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onFailure = useCallback((error: unknown) => {
    setMessage(describeError(error));

    if (error instanceof ApiError && error.status === 401) {
      setSession({ state: "unauthenticated", version: "" });
      setPayload(null);
    }
  }, []);

  const reload = useCallback(async () => {
    try {
      setPayload(await fetchState());
    } catch (error) {
      onFailure(error);
    }
  }, [onFailure]);

  const bootstrap = useCallback(async () => {
    try {
      const next = await fetchSession();
      setSession(next);

      if (next.state === "authenticated") {
        setPayload(await fetchState());
      }
    } catch (error) {
      setMessage(describeError(error));
    }
  }, []);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  const handleLogin = async () => {
    setMessage(null);
    await bootstrap();
  };

  const handleLogout = async () => {
    setBusy(true);

    try {
      await logoutRequest();
    } catch {
      // 失敗しても画面はログインへ戻す。cookie の破棄はサーバー側でも行う。
    } finally {
      setBusy(false);
      setSession({ state: "unauthenticated", version: session?.version ?? "" });
      setPayload(null);
      setTab("connections");
    }
  };

  if (!session) {
    return (
      <main class="login">
        <p class="muted">読み込み中…</p>
      </main>
    );
  }

  if (session.state === "misconfigured") {
    return (
      <main class="login">
        <section class="card login-card">
          <h1 class="login-title">設定を確認してください</h1>
          <p class="muted">
            PIN ハッシュ（<span class="mono">pin-hash</span>）またはセッション鍵（
            <span class="mono">session-key</span>）を読めません。データディレクトリを確認してください。
          </p>
          <p class="muted">
            PIN を再設定する場合は、この 2 ファイルを退避してから再読み込みしてください。状態が変わらない場合は
            中継サーバーを再起動してください。接続先と API キーは <span class="mono">relay.sqlite</span> に残ります。
          </p>
        </section>
      </main>
    );
  }

  if (session.state !== "authenticated") {
    return (
      <LoginScreen
        mode={session.state === "setup_required" ? "setup" : "login"}
        notice={message}
        onSuccess={handleLogin}
      />
    );
  }

  return (
    <div class="app">
      <header class="topbar">
        <div>
          <h1>u7agent Relay</h1>
          <p class="muted">外部クライアントから u7agent の会話へ中継します。</p>
        </div>
        <div class="topbar-actions">
          <span class="muted mono">{payload?.version ?? session.version}</span>
          <button class="button small" type="button" onClick={() => void reload()}>
            更新
          </button>
          <button class="button small" type="button" disabled={busy} onClick={() => void handleLogout()}>
            ログアウト
          </button>
        </div>
      </header>

      <nav class="tabs">
        {(Object.keys(TAB_LABELS) as Tab[]).map((key) => (
          <button key={key} type="button" class={tab === key ? "tab active" : "tab"} onClick={() => setTab(key)}>
            {TAB_LABELS[key]}
          </button>
        ))}
      </nav>

      {message ? (
        <div class="banner" role="alert">
          <span>{message}</span>
          <button class="button small" type="button" onClick={() => setMessage(null)}>
            閉じる
          </button>
        </div>
      ) : null}

      {!payload ? (
        <p class="muted">読み込み中…</p>
      ) : tab === "connections" ? (
        <ConnectionsPanel connections={payload.connections} reload={reload} onError={onFailure} />
      ) : tab === "keys" ? (
        <KeysPanel connections={payload.connections} keys={payload.keys} reload={reload} onError={onFailure} />
      ) : (
        <RunsPanel connections={payload.connections} runs={payload.runs} />
      )}
    </div>
  );
}
