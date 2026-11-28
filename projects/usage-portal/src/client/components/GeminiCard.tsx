import { useState } from "preact/hooks";
import type { GeminiLogoutOutcome, GeminiRefreshOutcome, UsageSource } from "../api";
import { GEMINI_SCOPE_NOTE, geminiLogoutMessage, geminiRefreshMessage } from "../lib/gemini";
import { OverflowMenu, type MenuItem } from "./OverflowMenu";
import { ProviderCard } from "./ProviderCard";

const FALLBACK_ERROR = "通信に失敗しました。もう一度試してください。";

/**
 * Gemini カード 1 枚ぶん。周期取得が無いので、取り直す入口は見出しのメニューにだけ置く。
 * ログアウトはカードを消す操作なので、確認はカードの中で行う。
 */
export function GeminiCard(props: {
  source: UsageSource;
  now: number;
  generatedAt: number | null;
  compact?: boolean;
  onRefresh: () => Promise<GeminiRefreshOutcome | null>;
  onLogout: () => Promise<GeminiLogoutOutcome>;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const refresh = async (): Promise<void> => {
    setRefreshing(true);
    setMessage(null);

    try {
      const outcome = await props.onRefresh();

      setMessage(geminiRefreshMessage(outcome));
      setFailed(outcome === null || outcome.state === "failed");
    } catch {
      setMessage(FALLBACK_ERROR);
      setFailed(true);
    } finally {
      setRefreshing(false);
    }
  };

  const logout = async (): Promise<void> => {
    setLoggingOut(true);
    setMessage(null);

    try {
      const outcome = await props.onLogout();

      // 完了するとカードは predicate で消える。残るのは、確認で接続が残った・確かめられなかった場合だけ。
      if (outcome === "done") {
        setConfirming(false);
      } else {
        setMessage(geminiLogoutMessage(outcome));
        setFailed(true);
      }
    } catch {
      setMessage(FALLBACK_ERROR);
      setFailed(true);
    } finally {
      setLoggingOut(false);
    }
  };

  const busy = refreshing || loggingOut;
  const items: MenuItem[] = [
    { label: "更新", onSelect: () => void refresh(), disabled: busy },
    {
      label: "ログアウトして非表示",
      onSelect: () => {
        setConfirming(true);
        setMessage(null);
      },
      disabled: busy,
      danger: true,
    },
  ];

  return (
    <ProviderCard
      source={props.source}
      now={props.now}
      generatedAt={props.generatedAt}
      compact={props.compact}
      headerMenu={<OverflowMenu label="Gemini の操作" items={items} />}
    >
      <p class="up-caption">{GEMINI_SCOPE_NOTE}</p>

      {loggingOut ? (
        <p class="up-caption" role="status">
          ログアウトしています…（取得中の処理を待つため、最大 45 秒かかります）
        </p>
      ) : refreshing ? (
        <p class="up-caption" role="status">
          更新しています…
        </p>
      ) : message === null ? null : (
        <p class={failed ? "up-error" : "up-caption"} role={failed ? "alert" : "status"}>
          {message}
        </p>
      )}

      {confirming ? (
        <section class="up-gemini">
          <p class="up-caption">
            この端末の Gemini
            の資格情報を削除し、カードを隠します。サインインし直すまで表示されません。利用枠の推移は残ります。
          </p>
          <div class="up-form-actions">
            <button class="up-button up-button-secondary" type="button" disabled={busy} onClick={() => void logout()}>
              ログアウトする
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
        </section>
      ) : null}
    </ProviderCard>
  );
}
