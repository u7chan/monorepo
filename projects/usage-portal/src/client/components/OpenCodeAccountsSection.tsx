import { useState } from "preact/hooks";
import { MAX_OPENCODE_ACCOUNTS } from "../../shared/opencode-account";
import type { OpenCodeAccount } from "../api";
import { OpenCodeAccountForm, type OpenCodeAccountActions } from "./OpenCodeAccountForm";

export type OpenCodeAccountsState =
  | { status: "loading"; accounts: OpenCodeAccount[] }
  | { status: "ok"; accounts: OpenCodeAccount[] }
  | { status: "unavailable"; accounts: OpenCodeAccount[] };

/** 一覧の追加入口。件数と空の案内を持ち、フォームは 1 つだけ開く。 */
export function OpenCodeAccountsSection(props: { state: OpenCodeAccountsState; actions: OpenCodeAccountActions }) {
  const [adding, setAdding] = useState(false);
  const accounts = props.state.accounts;
  const full = accounts.length >= MAX_OPENCODE_ACCOUNTS;

  return (
    <section class="up-opencode-accounts">
      <div class="up-section-head">
        <h2 class="up-subheading">OpenCode Go のアカウント</h2>
        <button class="up-button up-button-secondary" type="button" disabled={full} onClick={() => setAdding(!adding)}>
          {adding ? "追加を閉じる" : "アカウントを追加"}
        </button>
      </div>

      {props.state.status === "loading" ? <p class="up-caption">アカウントを確認しています…</p> : null}

      {props.state.status === "unavailable" ? (
        <p class="up-caption">アカウントの一覧を取得できませんでした。ページを再読み込みしてください。</p>
      ) : null}

      {props.state.status === "ok" && accounts.length === 0 ? (
        <p class="up-caption">OpenCode Go のアカウントは未登録です</p>
      ) : null}

      {full ? <p class="up-caption">登録できるアカウントは {MAX_OPENCODE_ACCOUNTS} 件までです。</p> : null}

      {adding ? (
        <OpenCodeAccountForm mode="create" onSubmit={props.actions.onCreate} onClose={() => setAdding(false)} />
      ) : null}
    </section>
  );
}
