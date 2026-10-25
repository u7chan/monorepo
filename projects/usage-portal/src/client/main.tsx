import { render } from "preact";
import { useCallback, useEffect, useState } from "preact/hooks";
import { type AuthOutcome, fetchSession, logout, submitPin } from "./api";
import { describeWait, expiryDaysLeft, lockSecondsLeft } from "./time";
import "./styles.css";

type View =
  | { kind: "loading" }
  | { kind: "setup" }
  | { kind: "login" }
  | { kind: "dashboard"; expiresAt: number }
  | { kind: "unreachable" };

function App() {
  const [view, setView] = useState<View>({ kind: "loading" });
  const [relogin, setRelogin] = useState(false);

  const load = useCallback(async () => {
    try {
      const session = await fetchSession();

      setView(
        session.state === "authenticated"
          ? { kind: "dashboard", expiresAt: session.expiresAt }
          : { kind: session.state === "setup_required" ? "setup" : "login" },
      );
      setRelogin(false);
    } catch {
      setView({ kind: "unreachable" });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

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
    case "setup":
      content = (
        <PinForm
          title="PIN を決める"
          description="この画面から 6 桁の PIN を登録します。次回からはこの PIN でログインします。"
          submitLabel="登録する"
          confirm
          onSubmit={(pin) => submitPin("/api/auth/setup", pin)}
          onSuccess={load}
        />
      );
      break;
    case "login":
      content = (
        <PinForm
          title="PIN を入力"
          description="6 桁の PIN を入力してください。"
          submitLabel="ログイン"
          onSubmit={(pin) => submitPin("/api/auth/login", pin)}
          onSuccess={load}
        />
      );
      break;
    case "dashboard":
      content = (
        <Dashboard
          expiresAt={view.expiresAt}
          relogin={relogin}
          onRelogin={() => setRelogin(true)}
          onCancelRelogin={() => setRelogin(false)}
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
        <span class="up-caption">表示専用</span>
      </footer>
    </>
  );
}

function PinForm(props: {
  title: string;
  description: string;
  submitLabel: string;
  confirm?: boolean;
  onSubmit: (pin: string) => Promise<AuthOutcome>;
  onSuccess: () => void | Promise<void>;
}) {
  const [pin, setPin] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lockedUntil, setLockedUntil] = useState(0);
  const [clock, setClock] = useState(() => Date.now());

  // ロック中は 1 秒ごとに再描画し、残り時間と送信可否を追随させる。
  useEffect(() => {
    if (lockedUntil === 0) {
      return;
    }

    const timer = setInterval(() => setClock(Date.now()), 1000);

    return () => clearInterval(timer);
  }, [lockedUntil]);

  const lockSeconds = lockSecondsLeft(lockedUntil, clock);
  const locked = lockSeconds > 0;
  const shownMessage = locked ? `試行回数が多すぎます。あと ${describeWait(lockSeconds)} 待ってください。` : message;

  const submit = async (event: Event) => {
    event.preventDefault();
    setMessage(null);

    if (props.confirm && pin !== confirmation) {
      setMessage("2 つの PIN が一致しません。");

      return;
    }

    setBusy(true);

    try {
      const outcome = await props.onSubmit(pin);

      if (outcome.ok) {
        await props.onSuccess();

        return;
      }

      setMessage(describeFailure(outcome));

      if (outcome.error === "rate_limited" && outcome.retryAfterSeconds) {
        setLockedUntil(Date.now() + outcome.retryAfterSeconds * 1000);
        setClock(Date.now());
      }

      setPin("");
      setConfirmation("");
    } catch {
      setMessage("通信に失敗しました。もう一度試してください。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section class="up-card">
      <h1 class="up-heading">{props.title}</h1>
      <p class="up-caption">{props.description}</p>
      <form class="up-form" onSubmit={submit}>
        {/* PIN だけの入口でもパスワードマネージャーが同じ項目として扱えるよう、利用者名を隠しで置く。 */}
        <input type="text" name="username" autocomplete="username" value="usage-portal" readOnly hidden />
        <label class="up-field">
          <span class="up-label">PIN</span>
          <input
            class="up-input"
            type="password"
            inputMode="numeric"
            pattern="[0-9]{6}"
            maxLength={6}
            autocomplete={props.confirm ? "new-password" : "current-password"}
            required
            value={pin}
            onInput={(event) => setPin((event.currentTarget as HTMLInputElement).value)}
          />
        </label>
        {props.confirm ? (
          <label class="up-field">
            <span class="up-label">PIN（確認）</span>
            <input
              class="up-input"
              type="password"
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              autocomplete="new-password"
              required
              value={confirmation}
              onInput={(event) => setConfirmation((event.currentTarget as HTMLInputElement).value)}
            />
          </label>
        ) : null}
        <button class="up-button" type="submit" disabled={busy || locked}>
          {busy ? "送信中…" : props.submitLabel}
        </button>
        {shownMessage ? <p class="up-error">{shownMessage}</p> : null}
      </form>
    </section>
  );
}

function Dashboard(props: {
  expiresAt: number;
  relogin: boolean;
  onRelogin: () => void;
  onCancelRelogin: () => void;
  onLoggedOut: () => void | Promise<void>;
}) {
  const [clock, setClock] = useState(() => Date.now());

  // 操作が無くても 3 日の境界を越えたらバナーを出せるように、時計を進める。
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 60_000);

    return () => clearInterval(timer);
  }, []);

  const expiryDays = expiryDaysLeft(props.expiresAt, clock);

  if (props.relogin) {
    return (
      <PinForm
        title="PIN を再入力"
        description="セッションを延長します。"
        submitLabel="延長する"
        onSubmit={(pin) => submitPin("/api/auth/login", pin)}
        onSuccess={() => {
          props.onCancelRelogin();
          void props.onLoggedOut();
        }}
      />
    );
  }

  return (
    <>
      {expiryDays !== null ? (
        <div class="up-banner">
          <p class="up-caption">ログインの有効期限が近づいています（あと {expiryDays} 日）</p>
          <button class="up-button" type="button" onClick={props.onRelogin}>
            PIN を再入力
          </button>
        </div>
      ) : null}
      <section class="up-card">
        <h1 class="up-heading">利用枠</h1>
        <p class="up-caption">利用枠の取得はまだ実装されていません。</p>
        <button
          class="up-button"
          type="button"
          onClick={async () => {
            await logout();
            await props.onLoggedOut();
          }}
        >
          ログアウト
        </button>
      </section>
    </>
  );
}

function describeFailure(outcome: Extract<AuthOutcome, { ok: false }>): string | null {
  switch (outcome.error) {
    case "invalid_pin":
      return "PIN が違います。";
    case "already_configured":
      return "PIN は設定済みです。ログインしてください。";
    case "setup_required":
      return "PIN が未設定です。ページを再読み込みしてください。";
    case "rate_limited":
      // 残り時間はロック期限から毎秒作り直す。固定文言を残すと解除後も古い待ち時間が出る。
      return null;
    case "origin_mismatch":
      return "開いている URL が想定と違います。同じ URL から開き直してください。";
    default:
      return "サーバーの認証設定が不正です。管理者に確認してください。";
  }
}

const root = document.getElementById("app");

if (!root) {
  throw new Error("#app が index.html にありません");
}

render(<App />, root);
