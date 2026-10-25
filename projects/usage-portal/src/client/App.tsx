import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import {
  type CodexAuthState,
  type ProviderId,
  type ProviderUsage,
  type UsagePayload,
  cancelCodexLogin,
  deleteOpenCodeKey,
  fetchCodexAuth,
  fetchOpenCodeAuth,
  fetchSession,
  fetchUsage,
  logout,
  logoutCodex,
  respondCodexLogin,
  saveOpenCodeKey,
  startCodexLogin,
} from "./api";
import { LoginScreen } from "./components/LoginScreen";
import type { OpenCodeConnection } from "./components/OpenCodeAuthPanel";
import { ProviderCard } from "./components/ProviderCard";
import { SessionExpiryBanner } from "./components/SessionExpiryBanner";
import { formatClock } from "./lib/format";
import { expiryNotice } from "./time";

type View =
  | { kind: "loading" }
  | { kind: "unreachable" }
  | { kind: "login"; mode: "setup" | "login"; notice: string | null }
  | { kind: "dashboard"; expiresAt: number };

const PLACEHOLDERS: readonly { id: ProviderId; name: string }[] = [
  { id: "codex", name: "Codex" },
  { id: "opencode-go", name: "OpenCode Go" },
];

export function App() {
  const [view, setView] = useState<View>({ kind: "loading" });

  const load = useCallback(async () => {
    try {
      const session = await fetchSession();

      if (session.state === "authenticated") {
        setView({ kind: "dashboard", expiresAt: session.expiresAt });

        return;
      }

      setView({
        kind: "login",
        mode: session.state === "setup_required" ? "setup" : "login",
        notice: null,
      });
    } catch {
      setView({ kind: "unreachable" });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const showLogin = useCallback((notice: string | null) => {
    setView({ kind: "login", mode: "login", notice });
  }, []);
  const handleUnauthorized = useCallback(
    () => showLogin("セッションが切れました。もう一度 PIN を入力してください。"),
    [showLogin],
  );
  const handleRelogin = useCallback(() => showLogin("PIN を再入力すると 30 日間延長されます。"), [showLogin]);

  let content;

  switch (view.kind) {
    case "loading":
      content = <p class="up-caption">読み込み中…</p>;
      break;
    case "unreachable":
      content = (
        <section class="up-card">
          <h1 class="up-heading">接続できません</h1>
          <p class="up-caption">サーバーに到達できませんでした。ページを再読み込みしてください。</p>
        </section>
      );
      break;
    case "login":
      content = <LoginScreen mode={view.mode} notice={view.notice} onSuccess={load} />;
      break;
    case "dashboard":
      content = (
        <Dashboard
          expiresAt={view.expiresAt}
          onUnauthorized={handleUnauthorized}
          onRelogin={handleRelogin}
          onLoggedOut={load}
        />
      );
      break;
  }

  return (
    <>
      <header class="up-header">
        <span class="up-brand">Usage</span>
        <span class="up-caption">Codex / OpenCode Go</span>
      </header>
      <main class="up-main">{content}</main>
      <footer class="up-footer">
        <span class="up-caption">5 分ごとに取得 · 表示専用</span>
      </footer>
    </>
  );
}

function Dashboard(props: {
  expiresAt: number;
  onUnauthorized: () => void;
  onRelogin: () => void;
  onLoggedOut: () => void | Promise<void>;
}) {
  const [usage, setUsage] = useState<UsagePayload | null>(null);
  const [codex, setCodex] = useState<CodexAuthState | null>(null);
  const [opencode, setOpenCode] = useState<OpenCodeConnection>({ status: "loading" });
  const [clock, setClock] = useState(() => Date.now());
  // 保存・解除より前に始まった GET の応答で、確定済みの状態を巻き戻さないための世代。
  const authGeneration = useRef(0);

  // 「あと N 日」と期限バナーを操作なしでも進める。
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 30_000);

    return () => clearInterval(timer);
  }, []);

  const { onUnauthorized } = props;

  const loadUsage = useCallback(async () => {
    const result = await fetchUsage();

    if (result && "unauthorized" in result) {
      onUnauthorized();

      return;
    }

    if (result) {
      setUsage(result);
    }
  }, [onUnauthorized]);

  const loadCodex = useCallback(async () => {
    const result = await fetchCodexAuth();

    if (result && "unauthorized" in result) {
      onUnauthorized();

      return;
    }

    if (result) {
      setCodex(result);
    }
  }, [onUnauthorized]);

  useEffect(() => {
    void loadUsage();

    const timer = setInterval(() => void loadUsage(), 60_000);

    return () => clearInterval(timer);
  }, [loadUsage]);

  useEffect(() => {
    void loadCodex();
  }, [loadCodex]);

  const loadOpenCode = useCallback(async () => {
    authGeneration.current += 1;

    const generation = authGeneration.current;

    try {
      const result = await fetchOpenCodeAuth();

      if (generation !== authGeneration.current) {
        return;
      }

      if (result && "unauthorized" in result) {
        onUnauthorized();

        return;
      }

      // 一度でも登録状態を読めていれば、再取得の失敗で「未登録」に戻さない。
      setOpenCode((current) =>
        result ? { status: "ok", auth: result } : current.status === "ok" ? current : { status: "unavailable" },
      );
    } catch {
      if (generation !== authGeneration.current) {
        return;
      }

      setOpenCode((current) => (current.status === "ok" ? current : { status: "unavailable" }));
    }
  }, [onUnauthorized]);

  useEffect(() => {
    void loadOpenCode();

    // 初回に読めなかったときの復帰と、別の端末からの登録を拾う。
    const timer = setInterval(() => void loadOpenCode(), 60_000);

    return () => clearInterval(timer);
  }, [loadOpenCode]);

  const retryOpenCode = useCallback(() => {
    setOpenCode({ status: "loading" });
    void loadOpenCode();
  }, [loadOpenCode]);

  const loginStatus = codex?.login?.status ?? null;

  // 進行中だけ 2 秒ごとに取り直す。終端に届いたら止める。
  useEffect(() => {
    if (loginStatus !== "running") {
      return;
    }

    const timer = setInterval(() => void loadCodex(), 2_000);

    return () => clearInterval(timer);
  }, [loginStatus, loadCodex]);

  // サインイン成功時は sampler が 1 回走っているので、カードをすぐ取り直す。
  useEffect(() => {
    if (loginStatus === "succeeded") {
      void loadUsage();
    }
  }, [loginStatus, loadUsage]);

  const startCodex = useCallback(async (): Promise<string | null> => {
    const outcome = await startCodexLogin();

    if (!outcome.ok) {
      return outcome.error;
    }

    setCodex(outcome.state);

    return null;
  }, []);

  const respondCodex = useCallback(
    async (value: string): Promise<string | null> => {
      const error = await respondCodexLogin(value);

      await loadCodex();

      return error;
    },
    [loadCodex],
  );

  const cancelCodex = useCallback(async (): Promise<void> => {
    await cancelCodexLogin();
    await loadCodex();
  }, [loadCodex]);

  const signOutCodex = useCallback(async (): Promise<boolean> => {
    const ok = await logoutCodex();

    await Promise.all([loadCodex(), loadUsage()]);

    return ok;
  }, [loadCodex, loadUsage]);

  const saveOpenCode = useCallback(
    async (apiKey: string): Promise<string | null> => {
      let outcome: Awaited<ReturnType<typeof saveOpenCodeKey>>;

      try {
        outcome = await saveOpenCodeKey(apiKey);
      } catch {
        return "unavailable";
      }

      if (!outcome.ok) {
        if (outcome.error === "unauthorized") {
          onUnauthorized();
        }

        return outcome.error;
      }

      // 保存より前に始まった GET の応答は捨てる。
      authGeneration.current += 1;
      setOpenCode({ status: "ok", auth: outcome.state });

      // 保存は確定している。直後の取得が失敗しても登録失敗として扱わない（60 秒後に再試行される）。
      void loadUsage().catch(() => undefined);

      return null;
    },
    [loadUsage, onUnauthorized],
  );

  const clearOpenCode = useCallback(async (): Promise<boolean> => {
    let ok = false;

    try {
      ok = await deleteOpenCodeKey();
    } catch {
      ok = false;
    }

    if (ok) {
      // 解除より前に始まった GET の応答は捨てる。
      authGeneration.current += 1;
      setOpenCode({ status: "ok", auth: { configured: false, savedAt: null } });
    }

    void loadOpenCode();
    void loadUsage().catch(() => undefined);

    return ok;
  }, [loadOpenCode, loadUsage]);

  const expiry = expiryNotice(props.expiresAt, clock);
  const providers = usage?.providers ?? placeholders();
  const codexActions = {
    onStart: startCodex,
    onRespond: respondCodex,
    onCancel: cancelCodex,
    onLogout: signOutCodex,
  };
  const openCodeActions = { onSave: saveOpenCode, onClear: clearOpenCode, onRetry: retryOpenCode };

  return (
    <>
      {expiry ? <SessionExpiryBanner remaining={expiry} onRelogin={props.onRelogin} /> : null}
      <div class="up-toolbar">
        <p class="up-caption">
          <span class="up-auto" aria-hidden="true">
            ●
          </span>{" "}
          <span>自動更新（60 秒）</span>
          <span class="up-toolbar-fetched">
            {usage ? ` · 最終取得 ${formatClock(usage.generatedAt)}` : " · 取得中…"}
          </span>
        </p>
        <button
          class="up-button up-button-secondary"
          type="button"
          onClick={async () => {
            await logout();
            await props.onLoggedOut();
          }}
        >
          ログアウト
        </button>
      </div>
      <div class="up-providers">
        {providers.map((provider) => (
          <ProviderCard
            key={provider.id}
            provider={provider}
            now={clock}
            codex={provider.id === "codex" ? { auth: codex, actions: codexActions } : undefined}
            opencode={provider.id === "opencode-go" ? { connection: opencode, actions: openCodeActions } : undefined}
          />
        ))}
      </div>
    </>
  );
}

function placeholders(): ProviderUsage[] {
  return PLACEHOLDERS.map(({ id, name }) => ({
    id,
    name,
    plan: null,
    state: "loading",
    capturedAt: null,
    error: null,
    limitReached: false,
    windows: [],
    notes: [],
    trend: null,
  }));
}
