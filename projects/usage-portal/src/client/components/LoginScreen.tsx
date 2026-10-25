import { useEffect, useState } from "preact/hooks";
import { type AuthOutcome, submitPin } from "../api";
import { describeWait, lockSecondsLeft } from "../time";

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

  const lockSeconds = lockSecondsLeft(lockedUntil, clock);
  const locked = lockSeconds > 0;
  const shownMessage = locked ? `試行回数が多すぎます。あと ${describeWait(lockSeconds)} 待ってください。` : message;

  const submit = async (event: Event) => {
    event.preventDefault();
    setMessage(null);

    if (confirm && pin !== confirmation) {
      setMessage("2 つの PIN が一致しません。");

      return;
    }

    setBusy(true);

    try {
      const outcome = await submitPin(confirm ? "/api/auth/setup" : "/api/auth/login", pin);

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
      <h1 class="up-heading">{confirm ? "PIN を決める" : "PIN を入力"}</h1>
      <p class="up-caption">
        {confirm
          ? "この画面から 6 桁の PIN を登録します。次回からはこの PIN でログインします。"
          : "6 桁の PIN を入力してください。"}
      </p>
      {props.notice ? <p class="up-notice">{props.notice}</p> : null}
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
            autocomplete={confirm ? "new-password" : "current-password"}
            required
            value={pin}
            onInput={(event) => setPin((event.currentTarget as HTMLInputElement).value)}
          />
        </label>
        {confirm ? (
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
          {busy ? "送信中…" : confirm ? "登録する" : "ログイン"}
        </button>
        {shownMessage ? (
          <p class="up-error" role="alert">
            {shownMessage}
          </p>
        ) : null}
      </form>
    </section>
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
