import { useState } from "preact/hooks";
import type { CodexAuthState } from "../api";

export type CodexActions = {
  onStart: () => Promise<string | null>;
  onRespond: (value: string) => Promise<string | null>;
  onCancel: () => Promise<void>;
  onLogout: () => Promise<boolean>;
};

const RESPONSE_ERRORS: Record<string, string> = {
  invalid_response: "値が正しくありません。画面を更新して選び直してください。",
  no_prompt: "いまは入力を受け付けていません。画面を更新してください。",
  login_not_running: "サインインはすでに終了しています。",
  login_in_progress: "サインインが進行中です。画面を更新してください。",
};

export function CodexAuthPanel(props: {
  auth: CodexAuthState | null;
  actions: CodexActions;
  /** 資格情報が失効している（未接続 / 再サインイン）。サインイン済みでも入り直せるようにする。 */
  needsSignIn: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [selected, setSelected] = useState("device_code");
  const [manualCode, setManualCode] = useState("");
  const [copied, setCopied] = useState(false);
  const login = props.auth?.login ?? null;
  const signedIn = props.auth?.signedIn ?? false;
  const running = login?.status === "running";
  // 認証状態の取得前は、未接続と決めつけずに操作を出さない。
  const known = props.auth !== null;
  const showStart =
    known && !running && login?.status !== "succeeded" && (!signedIn || props.needsSignIn || login !== null);
  const showSignOut = known && signedIn && !running && !props.needsSignIn;
  const options = login?.prompt?.type === "select" ? login.prompt.options : [];
  // 既定はデバイスコード。props は非同期に届くので、選択値を props の初期値に固定しない。
  const choice = options.some((option) => option.id === selected)
    ? selected
    : (options.find((option) => option.id === "device_code")?.id ?? options[0]?.id ?? "");

  const run = async (task: () => Promise<string | null>): Promise<void> => {
    setBusy(true);
    setMessage(null);

    try {
      const error = await task();

      setMessage(error === null ? null : (RESPONSE_ERRORS[error] ?? "操作できませんでした。もう一度試してください。"));
    } catch {
      setMessage("通信に失敗しました。もう一度試してください。");
    } finally {
      setBusy(false);
    }
  };

  const copy = async (value: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      // HTTP の LAN では clipboard API が使えないことがある。値は画面に出ているので手で選べる。
      setMessage("コピーできません。表示された値を選択してコピーしてください。");
    }
  };

  return (
    <section class="up-codex">
      <h3 class="up-subheading">Codex の接続</h3>
      <p class="up-caption">{props.needsSignIn ? "再サインインが必要です" : signedIn ? "サインイン済み" : "未接続"}</p>

      {login?.status === "running" ? (
        <>
          {login.instructions ? <p class="up-codex-instructions">{login.instructions}</p> : null}
          {login.userCode ? (
            <div class="up-codex-code">
              <span class="up-label">コード</span>
              <code class="up-code-string">{login.userCode}</code>
              <button
                class="up-button up-button-secondary"
                type="button"
                onClick={() => void copy(login.userCode ?? "")}
              >
                {copied ? "コピーしました" : "コピー"}
              </button>
            </div>
          ) : null}
          {login.authUrl ? (
            <p class="up-codex-link">
              <a class="up-link" href={login.authUrl} target="_blank" rel="noreferrer noopener">
                承認ページを開く
              </a>
              <span class="up-codex-url">{login.authUrl}</span>
            </p>
          ) : null}
          {login.progress ? <p class="up-caption">{login.progress}</p> : null}

          {login.prompt?.type === "select" ? (
            <form
              class="up-form up-form-inline"
              onSubmit={(event) => {
                event.preventDefault();
                void run(() => props.actions.onRespond(choice));
              }}
            >
              <fieldset class="up-fieldset">
                <legend class="up-label">{login.prompt.message}</legend>
                {login.prompt.options.map((option) => (
                  <label class="up-radio" key={option.id}>
                    <input
                      type="radio"
                      name="codex-login-method"
                      value={option.id}
                      checked={choice === option.id}
                      onChange={() => setSelected(option.id)}
                    />
                    {option.label}
                  </label>
                ))}
              </fieldset>
              <button class="up-button" type="submit" disabled={busy}>
                {busy ? "送信中…" : "続ける"}
              </button>
            </form>
          ) : null}

          {login.prompt?.type === "manual_code" ? (
            <form
              class="up-form up-form-inline"
              onSubmit={(event) => {
                event.preventDefault();
                void run(async () => {
                  const error = await props.actions.onRespond(manualCode);

                  if (error === null) {
                    setManualCode("");
                  }

                  return error;
                });
              }}
            >
              <label class="up-field">
                <span class="up-label">{login.prompt.message}</span>
                <input
                  class="up-input up-input-code"
                  type="text"
                  inputMode="url"
                  autocomplete="off"
                  value={manualCode}
                  onInput={(event) => setManualCode((event.currentTarget as HTMLInputElement).value)}
                />
              </label>
              <button class="up-button" type="submit" disabled={busy || manualCode.trim() === ""}>
                {busy ? "送信中…" : "送信"}
              </button>
            </form>
          ) : null}

          <button
            class="up-button up-button-secondary"
            type="button"
            disabled={busy}
            onClick={() => {
              void props.actions.onCancel();
              setMessage(null);
            }}
          >
            中断
          </button>
        </>
      ) : null}

      {login?.status === "succeeded" ? <p class="up-notice">サインインしました</p> : null}
      {login?.status === "failed" ? (
        <p class="up-error" role="alert">
          {login.error ?? "サインインに失敗しました。もう一度試してください。"}
        </p>
      ) : null}
      {login?.status === "cancelled" ? <p class="up-caption">サインインを中断しました。</p> : null}

      {showStart ? (
        <button
          class="up-button"
          type="button"
          disabled={busy}
          onClick={() => {
            setCopied(false);
            void run(() => props.actions.onStart());
          }}
        >
          {busy ? "開始中…" : "Sign in with ChatGPT"}
        </button>
      ) : null}

      {showSignOut ? (
        <button
          class="up-button up-button-secondary"
          type="button"
          disabled={busy}
          onClick={() => {
            void (async () => {
              setBusy(true);
              setMessage(null);

              const ok = await props.actions.onLogout();

              setMessage(ok ? null : "サインアウトできませんでした。もう一度試してください。");
              setBusy(false);
            })();
          }}
        >
          サインアウト
        </button>
      ) : null}

      {message ? (
        <p class="up-error" role="alert">
          {message}
        </p>
      ) : null}
    </section>
  );
}
