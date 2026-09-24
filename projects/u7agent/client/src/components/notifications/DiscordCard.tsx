import { DiscordIcon } from "../icons";
import { NotificationCard } from "./NotificationCard";
import { ToggleSwitch } from "./ToggleSwitch";

export type DiscordCardProps = {
  enabled: boolean;
  configured: boolean;
  webhookHint?: string;
  /** null = 保存済みを維持。文字列は「変更」で入力中の新しい値 (空は解除) */
  webhookUrl: string | null;
  onChangeEnabled: (enabled: boolean) => void;
  onChangeWebhookUrl: (webhookUrl: string | null) => void;
};

/** Discord の Webhook 登録。保存済み URL は write-only なので、変更は常に空の入力から始める */
export function DiscordCard({
  enabled,
  configured,
  webhookHint,
  webhookUrl,
  onChangeEnabled,
  onChangeWebhookUrl,
}: DiscordCardProps) {
  const editing = webhookUrl !== null;
  // 下書きの入力中も見て、保存後に送れる状態かを先に見せる (サーバーは enabled でも URL が無ければ送らない)
  const sendable = webhookUrl === null ? configured : webhookUrl.trim() !== "";
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
              {configured ? (webhookHint ? `登録済み（末尾 ${webhookHint}）` : "登録済み") : "未登録"}
            </span>
            <button type="button" className="btn-quiet" onClick={() => onChangeWebhookUrl("")}>
              {configured ? "変更" : "登録"}
            </button>
          </div>
        )}
        <p className="text-2xs leading-relaxed text-ink-ghost">
          保存済みの URL は再表示しません。変更するときは新しい URL を入れ直してください。
        </p>
        <p className="text-2xs leading-relaxed text-ink-ghost">
          会話のタイトル・エージェント名・応答本文の先頭 200 文字が Discord へ送られます。機微な会話では通知を Off
          にしてください。
        </p>
        {enabled && !sendable ? (
          <p className="text-2xs leading-relaxed text-warn">
            Webhook URL が未設定です。このままでは通知は送られません。
          </p>
        ) : null}
      </div>
    </NotificationCard>
  );
}
