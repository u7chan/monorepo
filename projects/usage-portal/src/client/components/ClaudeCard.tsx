import { useState } from "preact/hooks";
import type { ClaudeRefreshOutcome, UsageSource } from "../api";
import { OverflowMenu, type MenuItem } from "./OverflowMenu";
import { ProviderCard } from "./ProviderCard";

/**
 * Claude カード 1 枚ぶん。周期取得が無いので、取り直す入口は見出しのメニューと、
 * 未接続のときの案内にだけ置く。
 */
export function ClaudeCard(props: {
  source: UsageSource;
  now: number;
  generatedAt: number | null;
  compact?: boolean;
  onRefresh: () => Promise<ClaudeRefreshOutcome | null>;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const refresh = async (): Promise<void> => {
    setRefreshing(true);
    setMessage(null);

    try {
      const outcome = await props.onRefresh();

      setMessage(refreshMessage(outcome));
      setFailed(outcome === null || outcome.state === "failed");
    } catch {
      setMessage("通信に失敗しました。もう一度試してください。");
      setFailed(true);
    } finally {
      setRefreshing(false);
    }
  };

  const items: MenuItem[] = [{ label: "更新", onSelect: () => void refresh(), disabled: refreshing }];

  return (
    <ProviderCard
      source={props.source}
      now={props.now}
      generatedAt={props.generatedAt}
      compact={props.compact}
      headerMenu={<OverflowMenu label="Claude の操作" items={items} />}
    >
      {refreshing ? (
        <p class="up-caption" role="status">
          更新しています…
        </p>
      ) : message === null ? null : (
        <p class={failed ? "up-error" : "up-caption"} role={failed ? "alert" : "status"}>
          {message}
        </p>
      )}

      <SignInHelp source={props.source} />
    </ProviderCard>
  );
}

/** サインインは Web UI で中継せず、端末で 1 回だけ行う。ここには手順だけを出す。 */
function SignInHelp(props: { source: UsageSource }) {
  const code = props.source.error?.code ?? null;
  const lead = signInLead(code);

  if (lead === null) {
    return null;
  }

  return (
    <section class="up-claude">
      <p class="up-caption">{lead}</p>
      <div class="up-claude-command">
        <code class="up-code-string">docker exec -it &lt;コンテナ名&gt; claude auth login</code>
      </div>
      <p class="up-caption">サインインは Web UI では行いません。サインイン後に「更新」で取得します。</p>
    </section>
  );
}

function signInLead(code: string | null): string | null {
  switch (code) {
    case "not_connected":
      return "Claude にサインインしていません。端末で次のコマンドを実行してサインインしてください。";
    case "reauth_required":
      return "サインインの期限が切れています。端末で次のコマンドを実行してサインインし直してください。";
    case "subscription_required":
      return "Claude の Pro / Max でのサインインが必要です。端末で次のコマンドを実行し、サブスクリプションのアカウントでサインインしてください。";
    default:
      return null;
  }
}

function refreshMessage(outcome: ClaudeRefreshOutcome | null): string {
  if (outcome === null) {
    return "通信に失敗しました。もう一度試してください。";
  }

  switch (outcome.state) {
    case "refreshed":
      return "利用枠を更新しました。";
    case "skipped":
      return outcome.reason === "fresh"
        ? "15 分以内に取得した値を使っています。"
        : "前回の更新から 60 秒経っていません。少し待ってから更新してください。";
    default:
      return "更新に失敗しました。カードの状態を確認してください。";
  }
}
