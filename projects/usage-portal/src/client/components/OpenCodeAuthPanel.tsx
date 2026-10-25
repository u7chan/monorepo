import { useState } from "preact/hooks";
import type { OpenCodeAuthState } from "../api";
import { formatDateTime } from "../lib/format";

export type OpenCodeActions = {
  onSave: (apiKey: string) => Promise<string | null>;
  onClear: () => Promise<boolean>;
};

const ERROR_MESSAGES: Record<string, string> = {
  invalid_key: "このキーは受け付けられませんでした。値を確かめてください。",
  invalid_request: "キーの形式が正しくありません。",
  unavailable: "確認できませんでした。通信を確かめて、もう一度試してください。",
};

export function OpenCodeAuthPanel(props: { auth: OpenCodeAuthState | null; actions: OpenCodeActions }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const configured = props.auth?.configured ?? false;
  const savedAt = props.auth?.savedAt ?? null;

  const save = async (): Promise<void> => {
    const key = value.trim();

    if (key === "") {
      return;
    }

    setBusy(true);
    setMessage(null);

    try {
      const error = await props.actions.onSave(key);

      if (error === null) {
        // 保存したキーを入力欄へ残さない。画面を閉じるまで平文で保持しない。
        setValue("");
      } else {
        setMessage(ERROR_MESSAGES[error] ?? "登録できませんでした。もう一度試してください。");
      }
    } catch {
      setMessage("通信に失敗しました。もう一度試してください。");
    } finally {
      setBusy(false);
    }
  };

  const clear = async (): Promise<void> => {
    setBusy(true);
    setMessage(null);

    try {
      const ok = await props.actions.onClear();

      setMessage(ok ? null : "解除できませんでした。もう一度試してください。");
      setConfirming(!ok);
    } catch {
      setMessage("通信に失敗しました。もう一度試してください。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section class="up-opencode">
      <h3 class="up-subheading">OpenCode Go の接続</h3>
      <p class="up-caption">
        {configured
          ? `API キーを登録済み${savedAt === null ? "" : `（${formatDateTime(savedAt)} に保存）`}`
          : "API キーが未登録です"}
      </p>

      <form
        class="up-form up-form-inline"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label class="up-field">
          <span class="up-label">{configured ? "新しい API キー" : "API キー"}</span>
          <input
            class="up-input up-input-code"
            type="password"
            name="opencode-api-key"
            autocomplete="off"
            autocapitalize="off"
            spellcheck={false}
            placeholder={configured ? "置き換えるときだけ入力" : "API キーを貼り付け"}
            value={value}
            onInput={(event) => setValue((event.currentTarget as HTMLInputElement).value)}
          />
        </label>

        <div class="up-form-actions">
          <button class="up-button" type="submit" disabled={busy || value.trim() === ""}>
            {busy ? "確認中…" : configured ? "置き換える" : "登録する"}
          </button>
          {configured ? (
            <button
              class="up-button up-button-secondary"
              type="button"
              disabled={busy}
              onClick={() => setConfirming(true)}
            >
              解除
            </button>
          ) : null}
        </div>
      </form>

      {confirming && configured ? (
        <div class="up-form-actions">
          <p class="up-caption">解除すると利用枠を取得できなくなります。</p>
          <button class="up-button up-button-secondary" type="button" disabled={busy} onClick={() => void clear()}>
            解除する
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
      ) : null}

      {message ? (
        <p class="up-error" role="alert">
          {message}
        </p>
      ) : null}
    </section>
  );
}
