import { useState } from "preact/hooks";
import type { OpenCodeAccount, OpenCodeAccountInput, ProbeCheckOutcome, ProbeModel, UsageSource } from "../api";
import { probeErrorMessage } from "../lib/probe";
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
  /**
   * 一覧から引いた登録内容。取得できていなければ `null`。
   * probe の設定はここにしか無いので、無いあいだは接続確認と編集を出さない（キーを消さないため）。
   */
  account: OpenCodeAccount | null;
  /** 接続確認のモデル選択肢。catalog を取得できていなければ空。 */
  models: readonly ProbeModel[];
  onCheck: (id: string) => Promise<ProbeCheckOutcome>;
}) {
  const [panel, setPanel] = useState<Panel>("closed");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkMessage, setCheckMessage] = useState<string | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const identity = props.source.account;
  const account = props.account;

  // アカウントが無いカードは操作の対象にならない。メニューもパネルも出さない。
  if (!identity) {
    return (
      <ProviderCard source={props.source} now={props.now} generatedAt={props.generatedAt} compact={props.compact} />
    );
  }

  const update = (input: OpenCodeAccountInput): Promise<string | null> =>
    props.actions.onUpdate(identity.id, {
      name: input.name,
      icon: input.icon,
      // 空欄は「変更しない」。毎回送ると、変えるつもりの無いキーを上流へ投げることになる。
      ...(input.apiKey === "" ? {} : { apiKey: input.apiKey }),
      // 接続確認の設定は、選ばれていない場合も「解除」として明示的に送る。
      ...(input.probeModel === undefined && input.probeThinking === undefined
        ? {}
        : { probeModel: input.probeModel ?? null, probeThinking: input.probeThinking ?? null }),
    });

  const check = async (): Promise<void> => {
    setChecking(true);
    setCheckMessage(null);
    setCheckError(null);

    try {
      const outcome = await props.onCheck(identity.id);

      if (outcome.ok) {
        setCheckMessage(`接続できました（${outcome.latencyMs} ms）`);
      } else {
        setCheckError(probeErrorMessage(outcome.error));
      }
    } catch {
      setCheckError(probeErrorMessage("unavailable"));
    } finally {
      setChecking(false);
    }
  };

  const remove = async (): Promise<void> => {
    setBusy(true);
    setMessage(null);

    try {
      const ok = await props.actions.onDelete(identity.id);

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

  const configured = account !== null && account.probeModel !== null && account.probeThinking !== null;
  const items: MenuItem[] = [
    // 編集中に probe の設定を消さないよう、一覧が揃うまでは開かせない。
    { label: "編集", onSelect: () => show("edit"), disabled: busy || account === null },
    // 設定済みのアカウントだけ、そのキーで推論できるかを確かめられる。
    ...(configured ? [{ label: "接続確認", onSelect: () => void check(), disabled: busy || checking }] : []),
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
      {checkMessage ? (
        <p class="up-caption" role="status">
          {checkMessage}
        </p>
      ) : null}
      {checkError ? (
        <p class="up-error" role="alert">
          {checkError}
        </p>
      ) : null}

      {panel === "closed" || (panel === "edit" && account === null) ? null : (
        <section class="up-opencode">
          {panel === "edit" && account !== null ? (
            <OpenCodeAccountForm
              mode="edit"
              account={account}
              models={props.models}
              onSubmit={update}
              onClose={() => show("closed")}
            />
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
