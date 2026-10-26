import { useState } from "preact/hooks";
import type { OpenCodeAccountInput, UsageSourceAccount } from "../api";
import { OpenCodeAccountForm, type OpenCodeAccountActions } from "./OpenCodeAccountForm";

/** カード 1 枚ぶんの操作。編集フォームと、その場で確認する削除を持つ。 */
export function OpenCodeAccountPanel(props: { account: UsageSourceAccount; actions: OpenCodeAccountActions }) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const update = (input: OpenCodeAccountInput): Promise<string | null> =>
    props.actions.onUpdate(props.account.id, {
      name: input.name,
      icon: input.icon,
      // 空欄は「変更しない」。毎回送ると、変えるつもりの無いキーを上流へ投げることになる。
      ...(input.apiKey === "" ? {} : { apiKey: input.apiKey }),
    });

  const remove = async (): Promise<void> => {
    setBusy(true);
    setMessage(null);

    try {
      const ok = await props.actions.onDelete(props.account.id);

      setMessage(ok ? null : "削除できませんでした。もう一度試してください。");
      setConfirming(!ok);
    } catch {
      setMessage("通信に失敗しました。もう一度試してください。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section class="up-opencode">
      <div class="up-form-actions">
        <button
          class="up-button up-button-secondary"
          type="button"
          disabled={busy}
          onClick={() => {
            setEditing(!editing);
            setConfirming(false);
          }}
        >
          {editing ? "編集を閉じる" : "編集"}
        </button>
        <button
          class="up-button up-button-secondary"
          type="button"
          disabled={busy || confirming}
          onClick={() => {
            setConfirming(true);
            setEditing(false);
          }}
        >
          削除
        </button>
      </div>

      {editing ? (
        <OpenCodeAccountForm
          mode="edit"
          account={props.account}
          onSubmit={update}
          onClose={() => {
            setEditing(false);
            setMessage(null);
          }}
        />
      ) : null}

      {confirming ? (
        <div class="up-form-actions">
          <p class="up-caption">削除すると、このアカウントの利用枠と履歴も消えます。</p>
          <button class="up-button up-button-secondary" type="button" disabled={busy} onClick={() => void remove()}>
            削除する
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
