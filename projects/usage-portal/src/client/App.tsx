import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { MAX_OPENCODE_ACCOUNTS } from "../shared/opencode-account";
import {
  type CodexAuthState,
  type OpenCodeAccount,
  type OpenCodeAccountInput,
  type OpenCodeAccountPatch,
  type UsagePayload,
  type UsageSource,
  cancelCodexLogin,
  createOpenCodeAccount,
  deleteOpenCodeAccount,
  fetchCodexAuth,
  fetchOpenCodeAccounts,
  fetchSession,
  fetchUsage,
  logout,
  logoutCodex,
  respondCodexLogin,
  startCodexLogin,
  updateOpenCodeAccount,
} from "./api";
import { CodexCard } from "./components/CodexCard";
import { LoginScreen } from "./components/LoginScreen";
import { Modal } from "./components/Modal";
import { OpenCodeAccountCard } from "./components/OpenCodeAccountCard";
import { OpenCodeAccountForm, type OpenCodeAccountActions } from "./components/OpenCodeAccountForm";
import { OverflowMenu, type MenuItem } from "./components/OverflowMenu";
import { SessionExpiryBanner } from "./components/SessionExpiryBanner";
import { ViewModeToggle } from "./components/ViewModeToggle";
import { formatClock } from "./lib/format";
import { type ViewMode, browserStorage, readViewMode, writeViewMode } from "./lib/view-mode";
import { expiryNotice } from "./time";

type View =
  | { kind: "loading" }
  | { kind: "unreachable" }
  | { kind: "login"; mode: "setup" | "login"; notice: string | null }
  | { kind: "dashboard"; expiresAt: number };

type AccountsState = { status: "loading" | "ok" | "unavailable"; accounts: OpenCodeAccount[] };

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

  // ダッシュボードはヘッダーにメニューを持つため、レイアウトごと自分で描く。
  if (view.kind === "dashboard") {
    return (
      <Dashboard
        expiresAt={view.expiresAt}
        onUnauthorized={handleUnauthorized}
        onRelogin={handleRelogin}
        onLoggedOut={load}
      />
    );
  }

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
  }

  return <Layout>{content}</Layout>;
}

function Layout(props: { children: ComponentChildren; tools?: ComponentChildren; menu?: ComponentChildren }) {
  return (
    <>
      <header class="up-header">
        <span class="up-brand">Usage</span>
        <span class="up-caption">Codex / OpenCode Go</span>
        {props.tools || props.menu ? (
          <div class="up-header-actions">
            {props.tools}
            {props.menu}
          </div>
        ) : null}
      </header>
      <main class="up-main">{props.children}</main>
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
  const [accounts, setAccounts] = useState<AccountsState>({ status: "loading", accounts: [] });
  const [clock, setClock] = useState(() => Date.now());
  const [adding, setAdding] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>(() => readViewMode(browserStorage()));
  const changeViewMode = useCallback((mode: ViewMode) => {
    setViewMode(mode);
    writeViewMode(browserStorage(), mode);
  }, []);
  // 保存・削除より前に始まった GET の応答で、確定済みの一覧・カードを巻き戻さないための世代。
  const accountsGeneration = useRef(0);
  const usageGeneration = useRef(0);

  // 「あと N 日」と期限バナーを操作なしでも進める。
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 30_000);

    return () => clearInterval(timer);
  }, []);

  const { onLoggedOut, onUnauthorized } = props;

  const loadUsage = useCallback(async () => {
    usageGeneration.current += 1;

    const generation = usageGeneration.current;
    const result = await fetchUsage();

    // 一覧と同じく、操作より前の応答は捨てる。後着で削除済みのカードが戻らないようにする。
    if (generation !== usageGeneration.current) {
      return;
    }

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

  const loadAccounts = useCallback(async () => {
    accountsGeneration.current += 1;

    const generation = accountsGeneration.current;

    try {
      const result = await fetchOpenCodeAccounts();

      if (generation !== accountsGeneration.current) {
        return;
      }

      if (result && "unauthorized" in result) {
        onUnauthorized();

        return;
      }

      // 一度でも一覧を読めていれば、再取得の失敗で「未登録」に戻さない。
      setAccounts((current) =>
        result
          ? { status: "ok", accounts: result }
          : { status: current.status === "ok" ? "ok" : "unavailable", accounts: current.accounts },
      );
    } catch {
      if (generation !== accountsGeneration.current) {
        return;
      }

      setAccounts((current) => ({
        status: current.status === "ok" ? "ok" : "unavailable",
        accounts: current.accounts,
      }));
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

  // アカウントの一覧は初回だけ取る。追加・削除・名前の変更のあとにだけ取り直す。
  useEffect(() => {
    void loadAccounts();
  }, [loadAccounts]);

  /** 保存・削除のあとは一覧と利用枠を取り直す。片方が失敗しても操作の成否は変えない。 */
  const refreshAfterChange = useCallback(async () => {
    await Promise.allSettled([loadAccounts(), loadUsage()]);
  }, [loadAccounts, loadUsage]);

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

  const createAccount = useCallback(
    async (input: OpenCodeAccountInput): Promise<string | null> => {
      let outcome: Awaited<ReturnType<typeof createOpenCodeAccount>>;

      try {
        outcome = await createOpenCodeAccount(input);
      } catch {
        return "unavailable";
      }

      if (!outcome.ok) {
        if (outcome.error === "unauthorized") {
          onUnauthorized();
        }

        return outcome.error;
      }

      await refreshAfterChange();

      return null;
    },
    [onUnauthorized, refreshAfterChange],
  );

  const updateAccount = useCallback(
    async (id: string, patch: OpenCodeAccountPatch): Promise<string | null> => {
      let outcome: Awaited<ReturnType<typeof updateOpenCodeAccount>>;

      try {
        outcome = await updateOpenCodeAccount(id, patch);
      } catch {
        return "unavailable";
      }

      if (!outcome.ok) {
        if (outcome.error === "unauthorized") {
          onUnauthorized();
        }

        return outcome.error;
      }

      await refreshAfterChange();

      return null;
    },
    [onUnauthorized, refreshAfterChange],
  );

  const removeAccount = useCallback(
    async (id: string): Promise<boolean> => {
      let ok = false;

      try {
        ok = await deleteOpenCodeAccount(id);
      } catch {
        ok = false;
      }

      await refreshAfterChange();

      return ok;
    },
    [refreshAfterChange],
  );

  const signOut = useCallback(async (): Promise<void> => {
    await logout();
    await onLoggedOut();
  }, [onLoggedOut]);

  const expiry = expiryNotice(props.expiresAt, clock);
  const sources = usage?.sources ?? placeholderSources(accounts.accounts);
  const codexActions = {
    onStart: startCodex,
    onRespond: respondCodex,
    onCancel: cancelCodex,
    onLogout: signOutCodex,
  };
  const openCodeActions: OpenCodeAccountActions = {
    onCreate: createAccount,
    onUpdate: updateAccount,
    onDelete: removeAccount,
  };
  const atLimit = accounts.accounts.length >= MAX_OPENCODE_ACCOUNTS;
  const menu: MenuItem[] = [
    {
      label: atLimit ? `アカウントを追加（上限 ${MAX_OPENCODE_ACCOUNTS} 件）` : "アカウントを追加",
      onSelect: () => setAdding(true),
      disabled: atLimit,
    },
    { label: "ログアウト", onSelect: () => void signOut(), danger: true },
  ];

  const compact = viewMode === "compact";

  return (
    <Layout
      tools={<ViewModeToggle mode={viewMode} onChange={changeViewMode} />}
      menu={<OverflowMenu label="メニュー" items={menu} />}
    >
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
      </div>
      <div class="up-providers" data-density={viewMode}>
        {sources.map((source) =>
          source.provider === "codex" ? (
            <CodexCard
              key={source.id}
              source={source}
              now={clock}
              generatedAt={usage?.generatedAt ?? null}
              compact={compact}
              auth={codex}
              actions={codexActions}
            />
          ) : (
            <OpenCodeAccountCard
              key={source.id}
              source={source}
              now={clock}
              generatedAt={usage?.generatedAt ?? null}
              compact={compact}
              actions={openCodeActions}
            />
          ),
        )}
        {accounts.status === "ok" && accounts.accounts.length === 0 ? (
          <section class="up-card up-empty-provider">
            <h2 class="up-subheading">OpenCode Go</h2>
            <p class="up-caption">アカウントが未登録です。API キーを登録するとカードが増えます。</p>
            <button class="up-button" type="button" disabled={atLimit} onClick={() => setAdding(true)}>
              アカウントを追加
            </button>
          </section>
        ) : null}
      </div>
      {accounts.status === "unavailable" ? (
        <p class="up-caption">アカウントの一覧を取得できませんでした。ページを再読み込みしてください。</p>
      ) : null}
      {adding ? (
        <Modal title="OpenCode Go のアカウントを追加" onClose={() => setAdding(false)}>
          {(close) => <OpenCodeAccountForm mode="create" onSubmit={createAccount} onClose={close} />}
        </Modal>
      ) : null}
    </Layout>
  );
}

/** `/api/usage` がまだ返っていない間の骨格。アカウントは登録済みの数だけ並べる。 */
function placeholderSources(accounts: readonly OpenCodeAccount[]): UsageSource[] {
  const placeholder = {
    state: "loading" as const,
    capturedAt: null,
    error: null,
    limitReached: false,
    windows: [],
    notes: [],
    trends: [],
  };

  return [
    { id: "codex", provider: "codex", name: "Codex", plan: null, account: null, ...placeholder },
    ...accounts.map((account) => ({
      id: account.id,
      provider: "opencode-go" as const,
      name: account.name,
      plan: null,
      account: { id: account.id, name: account.name, icon: account.icon },
      ...placeholder,
    })),
  ];
}
