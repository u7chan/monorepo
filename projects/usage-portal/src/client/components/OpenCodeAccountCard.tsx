import { useState } from "preact/hooks";
import type { OpenCodeAccountInput, UsageSource } from "../api";
import { OpenCodeAccountForm, type OpenCodeAccountActions } from "./OpenCodeAccountForm";
import { OverflowMenu, type MenuItem } from "./OverflowMenu";
import { ProviderCard } from "./ProviderCard";

type Panel = "closed" | "edit" | "delete";

/** カード 1 枚ぶんの操作。メニューは見出し、編集フォームと削除確認はカードの下に開く。 */
export function OpenCodeAccountCard(props: {
  source: UsageSource;
  now: number;
  generatedAt: number | null;
  compact?: boolean;
  actions: OpenCodeAccountActions;
}) {
  const [panel, setPanel] = useState<Panel>("closed");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const account = props.source.account;

  // アカウントが無いカードは操作の対象にならない。メニューもパネルも出さない。
  if (!account) {
    return (
      <ProviderCard source={props.source} now={props.now} generatedAt={props.generatedAt} compact={props.compact} />
    );
  }

  const update = (input: OpenCodeAccountInput): Promise<string | null> =>
    props.actions.onUpdate(account.id, {
      name: input.name,
      icon: input.icon,
      // 空欄は「変更しない」。毎回送ると、変えるつもりの無いキーを上流へ投げることになる。
      ...(input.apiKey === "" ? {} : { apiKey: input.apiKey }),
    });

  const remove = async (): Promise<void> => {
    setBusy(true);
    setMessage(null);

    try {
      const ok = await props.actions.onDelete(account.id);

      if (ok) {
        setPanel("closed");
      } else {
        setMessage("削除できませんでした。もう一度試してください。");
      }
    } catch {
      setMessage("通信に失敗しました。もう一度試してください。");
    } finally {
      setBusy(false);
    }
  };

  const show = (next: Panel): void => {
    setPanel(next);
    setMessage(null);
  };

  const items: MenuItem[] = [
    { label: "編集", onSelect: () => show("edit"), disabled: busy },
    { label: "削除", onSelect: () => show("delete"), disabled: busy, danger: true },
  ];

  return (
    <ProviderCard
      source={props.source}
      now={props.now}
      generatedAt={props.generatedAt}
      compact={props.compact}
      headerMenu={<OverflowMenu label="このアカウントの操作" items={items} />}
    >
      {panel === "closed" ? null : (
        <section class="up-opencode">
          {panel === "edit" ? (
            <OpenCodeAccountForm mode="edit" account={account} onSubmit={update} onClose={() => show("closed")} />
          ) : (
            <div class="up-form-actions">
              <p class="up-caption">削除すると、このアカウントの利用枠と履歴も消えます。</p>
              <button class="up-button up-button-secondary" type="button" disabled={busy} onClick={() => void remove()}>
                削除する
              </button>
              <button
                class="up-button up-button-secondary"
                type="button"
                disabled={busy}
                onClick={() => show("closed")}
              >
                やめる
              </button>
            </div>
          )}

          {message ? (
            <p class="up-error" role="alert">
              {message}
            </p>
          ) : null}
        </section>
      )}
    </ProviderCard>
  );
}
