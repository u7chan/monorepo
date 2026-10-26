import { useState } from "preact/hooks";
import {
  MAX_OPENCODE_ACCOUNTS,
  MAX_OPENCODE_ACCOUNT_NAME_LENGTH,
  OPENCODE_ACCOUNT_ICONS,
  normalizeAccountName,
} from "../../shared/opencode-account";
import type { OpenCodeAccountInput, OpenCodeAccountPatch } from "../api";

export type OpenCodeAccountActions = {
  /** 成功なら `null`、失敗なら画面に出すコード。 */
  onCreate: (input: OpenCodeAccountInput) => Promise<string | null>;
  onUpdate: (id: string, patch: OpenCodeAccountPatch) => Promise<string | null>;
  onDelete: (id: string) => Promise<boolean>;
};

const ERROR_MESSAGES: Record<string, string> = {
  invalid_name: `名前は 1〜${MAX_OPENCODE_ACCOUNT_NAME_LENGTH} 文字で入力してください。`,
  invalid_icon: "アイコンを選び直してください。",
  invalid_key: "このキーは受け付けられませんでした。値を確かめてください。",
  invalid_request: "入力の形式が正しくありません。",
  limit_reached: `登録できるアカウントは ${MAX_OPENCODE_ACCOUNTS} 件までです。`,
  not_found: "このアカウントはすでに削除されています。画面を更新してください。",
  unauthorized: "セッションが切れました。もう一度 PIN を入力してください。",
  unavailable: "確認できませんでした。通信を確かめて、もう一度試してください。",
};

export function openCodeAccountErrorMessage(error: string): string {
  return ERROR_MESSAGES[error] ?? "保存できませんでした。もう一度試してください。";
}

/** 追加と編集で同じ入力を使う。編集では API キーを空のままにすると変更しない。 */
export function OpenCodeAccountForm(props: {
  mode: "create" | "edit";
  account?: { id: string; name: string; icon: string };
  onSubmit: (input: OpenCodeAccountInput) => Promise<string | null>;
  onClose: () => void;
}) {
  const [name, setName] = useState(props.account?.name ?? "");
  const [icon, setIcon] = useState<string>(props.account?.icon ?? OPENCODE_ACCOUNT_ICONS[0]);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const groupName = props.account ? `opencode-icon-${props.account.id}` : "opencode-icon-new";
  const editing = props.mode === "edit";

  const submit = async (): Promise<void> => {
    // 名前の規則は server と同じ 1 つだけを使う。HTML の maxLength はコードポイントではなく
    // UTF-16 単位なので、絵文字を含む名前を入力中に切ってしまう。
    const normalizedName = normalizeAccountName(name);
    const trimmedKey = apiKey.trim();

    if (normalizedName === null) {
      setMessage(openCodeAccountErrorMessage("invalid_name"));

      return;
    }

    if (!editing && trimmedKey === "") {
      setMessage("API キーを入力してください。");

      return;
    }

    setBusy(true);
    setMessage(null);

    try {
      const error = await props.onSubmit({ name: normalizedName, icon, apiKey: trimmedKey });

      if (error === null) {
        // 入力したキーを画面に残さない。閉じるまで平文で保持しない。
        setApiKey("");
        props.onClose();
      } else {
        setMessage(openCodeAccountErrorMessage(error));
      }
    } catch {
      setMessage("通信に失敗しました。もう一度試してください。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      class="up-form up-form-inline"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label class="up-field">
        <span class="up-label">名前</span>
        <input
          class="up-input"
          type="text"
          name={`${groupName}-name`}
          autocomplete="off"
          value={name}
          onInput={(event) => setName((event.currentTarget as HTMLInputElement).value)}
        />
      </label>

      <fieldset class="up-fieldset">
        <legend class="up-label">アイコン</legend>
        <div class="up-icon-picker">
          {OPENCODE_ACCOUNT_ICONS.map((preset) => (
            <label class="up-icon-option" key={preset}>
              <input
                type="radio"
                name={groupName}
                value={preset}
                aria-label={preset}
                checked={icon === preset}
                onChange={() => setIcon(preset)}
              />
              <span aria-hidden="true">{preset}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <label class="up-field">
        <span class="up-label">{editing ? "新しい API キー" : "API キー"}</span>
        <input
          class="up-input up-input-code"
          type="password"
          name={`${groupName}-key`}
          autocomplete="off"
          autocapitalize="off"
          spellcheck={false}
          placeholder={editing ? "変更するときだけ入力" : "API キーを貼り付け"}
          value={apiKey}
          onInput={(event) => setApiKey((event.currentTarget as HTMLInputElement).value)}
        />
      </label>

      <div class="up-form-actions">
        <button class="up-button" type="submit" disabled={busy}>
          {busy ? "確認中…" : editing ? "保存する" : "追加する"}
        </button>
        <button class="up-button up-button-secondary" type="button" disabled={busy} onClick={props.onClose}>
          キャンセル
        </button>
      </div>

      {message ? (
        <p class="up-error" role="alert">
          {message}
        </p>
      ) : null}
    </form>
  );
}
