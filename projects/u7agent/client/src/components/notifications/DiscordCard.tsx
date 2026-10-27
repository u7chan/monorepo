import { ToggleSwitch } from "../ToggleSwitch";
import { DiscordIcon } from "../icons";
import { NotificationCard } from "./NotificationCard";

export type DiscordCardProps = {
  enabled: boolean;
  configured: boolean;
  /** 保存済みの URL を復号でき、送信に使える */
  webhookAvailable: boolean;
  /** 復号を評価済みか。false は「まだ確認できていない」で、失敗とは区別する */
  webhookEvaluated: boolean;
  /** 未評価 / 復号失敗の固定文言 (サーバーが返す) */
  webhookErrorMessage: string | null;
  /** null = 保存済みを維持。文字列は「変更」で入力中の新しい値 (空は解除) */
  webhookUrl: string | null;
  onChangeEnabled: (enabled: boolean) => void;
  onChangeWebhookUrl: (webhookUrl: string | null) => void;
};

/** Discord の Webhook 登録。保存済み URL は write-only なので、変更は常に空の入力から始める */
export function DiscordCard({
  enabled,
  configured,
  webhookAvailable,
  webhookEvaluated,
  webhookErrorMessage,
  webhookUrl,
  onChangeEnabled,
  onChangeWebhookUrl,
}: DiscordCardProps) {
  const editing = webhookUrl !== null;
  // 下書きの入力中も見て、保存後に送れる状態かを先に見せる (サーバーは enabled でも URL が無ければ送らない)
  const sendable = webhookUrl === null ? webhookAvailable : webhookUrl.trim() !== "";
  return (
    <NotificationCard
      title={
        <>
          <DiscordIcon />
          <span>DISCORD</span>
        </>
      }
      action={<ToggleSwitch checked={enabled} label={enabled ? "有効" : "無効"} onChange={onChangeEnabled} />}
    >
      <div className="grid gap-1.5">
        <span className="text-2xs text-ink-faint">Webhook URL</span>
        {editing ? (
          <div className="grid gap-1.5">
            <input
              className="field text-xs"
              type="text"
              value={webhookUrl}
              placeholder="https://discord.com/api/webhooks/…"
              aria-label="Webhook URL"
              autoComplete="off"
              spellCheck={false}
              // updater は遅延評価されるため、イベントの値は updater の外で読む (currentTarget は null になる)
              onChange={(event) => {
                const value = event.currentTarget.value;
                onChangeWebhookUrl(value);
              }}
            />
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className="btn-quiet" onClick={() => onChangeWebhookUrl(null)}>
                取り消し
              </button>
              <span className="text-2xs leading-4 break-words text-ink-ghost">
                discord.com の /api/webhooks/&lt;id&gt;/&lt;token&gt; の形だけを受け付けます。
              </span>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-ink">
              {!configured ? "未登録" : webhookAvailable ? "登録済み" : "登録済み（利用できません）"}
            </span>
            <button type="button" className="btn-quiet" onClick={() => onChangeWebhookUrl("")}>
              {configured ? "変更" : "登録"}
            </button>
          </div>
        )}
        <p className="text-2xs leading-relaxed text-ink-ghost">
          保存済みの URL は再表示しません（末尾の数文字も含めて返しません）。変更するときは新しい URL
          を入れ直してください。 URL は暗号化して保存され、master
          key（U7AGENT_SECRET_MASTER_KEY）が未設定の間は送信に使えません。
        </p>
        {configured && webhookErrorMessage ? (
          <p role="alert" className="text-2xs leading-relaxed text-warn">
            {webhookErrorMessage}
            {webhookEvaluated ? "" : "（再起動するか、URL を保存し直すと確認できます）"}
          </p>
        ) : null}
        <p className="text-2xs leading-relaxed text-ink-ghost">
          会話の通知を Off にしても、質問の通知（本文なし）は届きます。会話の通知を On にすると、会話のタイトル・
          エージェント名・応答本文の先頭 200 文字が Discord へ送られます。機微な会話では会話の通知を Off
          にしてください。
        </p>
        {enabled && !sendable && !configured ? (
          // 未保存のときだけ「未設定」と言う。保存済みで使えない理由はサーバーの固定文言で示す
          <p className="text-2xs leading-relaxed text-warn">
            Webhook URL が未設定です。このままでは通知は送られません。
          </p>
        ) : null}
      </div>
    </NotificationCard>
  );
}
