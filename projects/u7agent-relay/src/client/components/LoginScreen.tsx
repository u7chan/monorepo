import { useEffect, useState } from "preact/hooks";
import { ApiError, describeError, submitPin } from "../api";

export function LoginScreen(props: {
  mode: "setup" | "login";
  notice: string | null;
  onSuccess: () => void | Promise<void>;
}) {
  const [pin, setPin] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lockedUntil, setLockedUntil] = useState(0);
  const [clock, setClock] = useState(() => Date.now());
  const confirm = props.mode === "setup";

  // ロック中は 1 秒ごとに再描画し、残り時間と送信可否を追随させる。
  useEffect(() => {
    if (lockedUntil === 0) {
      return;
    }

    const timer = setInterval(() => setClock(Date.now()), 1000);

    return () => clearInterval(timer);
  }, [lockedUntil]);

  const lockSeconds = Math.max(0, Math.ceil((lockedUntil - clock) / 1000));
  const locked = lockSeconds > 0;
  const shownMessage = locked ? `試行回数が多すぎます。あと ${lockSeconds} 秒待ってください。` : message;

  const submit = async (event: Event) => {
    event.preventDefault();
    setMessage(null);

    if (confirm && pin !== confirmation) {
      setMessage("2 つの PIN が一致しません。");

      return;
    }

    setBusy(true);

    try {
      await submitPin(confirm ? "/api/auth/setup" : "/api/auth/login", pin);
      await props.onSuccess();
    } catch (error) {
      setMessage(describeError(error));

      if (error instanceof ApiError && error.code === "rate_limited" && error.retryAfterSeconds) {
        setLockedUntil(Date.now() + error.retryAfterSeconds * 1000);
        setClock(Date.now());
      }

      setPin("");
      setConfirmation("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main class="login">
      <section class="card login-card">
        <h1 class="login-title">{confirm ? "PIN を決める" : "PIN を入力"}</h1>
        <p class="muted">
          {confirm
            ? "この画面から 6 桁の PIN を登録します。次回からはこの PIN でログインします。"
            : "6 桁の PIN を入力してください。"}
        </p>
        {props.notice ? <p class="notice">{props.notice}</p> : null}
        <form class="stack" onSubmit={submit}>
          {/* PIN だけの入口でもパスワードマネージャーが同じ項目として扱えるよう、利用者名を隠しで置く。 */}
          <input type="text" name="username" autocomplete="username" value="u7agent-relay" readOnly hidden />
          <label class="field">
            <span>PIN</span>
            <input
              class="pin-input"
              type="password"
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              autocomplete={confirm ? "new-password" : "current-password"}
              required
              value={pin}
              onInput={(event) => setPin((event.currentTarget as HTMLInputElement).value)}
            />
          </label>
          {confirm ? (
            <label class="field">
              <span>PIN（確認）</span>
              <input
                class="pin-input"
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
          <button class="button primary" type="submit" disabled={busy || locked}>
            {busy ? "送信中…" : confirm ? "登録する" : "ログイン"}
          </button>
          {shownMessage ? (
            <p class="error" role="alert">
              {shownMessage}
            </p>
          ) : null}
        </form>
      </section>
    </main>
  );
}
