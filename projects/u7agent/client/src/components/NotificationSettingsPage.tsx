import type { Notifications } from "../hooks/useNotifications";
import { notificationPreviewLines, testAvailable, testNeedsSave } from "../lib/notifications";
import { CheckIcon } from "./icons";
import { DiscordCard } from "./notifications/DiscordCard";
import { LinkCard } from "./notifications/LinkCard";
import { MessageCard } from "./notifications/MessageCard";
import { TestSendCard } from "./notifications/TestSendCard";
import { SettingsPageLayout, type SettingsPageProps } from "./SettingsPageLayout";

export type NotificationSettingsPageProps = SettingsPageProps & {
  notifications: Notifications;
};

/** 設定 → 通知。編集はすべて下書きで、[保存] でまとめて PUT する */
export function NotificationSettingsPage({
  notifications,
  compact = false,
  onBack,
  onOpenNav,
}: NotificationSettingsPageProps) {
  const { settings, draft, setDraft, dirty, saving, testing, note, reload, save, test, discard } = notifications;
  const needsSave = testNeedsSave(draft);

  return (
    <SettingsPageLayout
      eyebrow="NOTIFICATIONS"
      title="通知"
      caption="通知を On にした会話で、エージェントの応答が返ってきたときに送ります。"
      actions={
        <>
          <button type="button" className="btn-quiet" disabled={!dirty || saving} onClick={discard}>
            破棄
          </button>
          <button type="button" className="btn-primary" disabled={!dirty || saving} onClick={() => void save()}>
            <CheckIcon />
            保存
          </button>
        </>
      }
      note={note}
      compact={compact}
      onOpenNav={onOpenNav}
      onBack={onBack}
    >
      <div className="min-h-0 min-w-0 scrollbar-thin overflow-x-hidden overflow-y-auto px-4 py-4">
        <div className="mx-auto grid max-w-3xl gap-3">
          {settings ? (
            <>
              <DiscordCard
                enabled={draft.enabled}
                configured={settings.configured}
                webhookHint={settings.webhookHint}
                webhookUrl={draft.webhookUrl}
                onChangeEnabled={(enabled) => setDraft({ enabled })}
                onChangeWebhookUrl={(webhookUrl) => setDraft({ webhookUrl })}
              />
              <TestSendCard
                available={testAvailable(draft, settings)}
                needsSave={needsSave}
                saving={saving}
                testing={testing}
                lastResult={settings.lastResult}
                onTest={() => void test(needsSave)}
              />
              <LinkCard value={draft.baseUrl} onChange={(baseUrl) => setDraft({ baseUrl })} />
              <MessageCard
                mention={draft.mention}
                previewLines={notificationPreviewLines(draft)}
                onChangeMention={(mention) => setDraft({ mention })}
              />
            </>
          ) : (
            <div className="grid justify-items-start gap-2 rounded-lg border border-line bg-soft p-3 text-xs text-ink-muted">
              {note.error ? (
                <>
                  <p role="alert">通知の設定を読み込めませんでした。</p>
                  <button type="button" className="btn-quiet" onClick={() => void reload()}>
                    再読み込み
                  </button>
                </>
              ) : (
                <p role="status">通知の設定を読み込んでいます。</p>
              )}
            </div>
          )}
        </div>
      </div>
    </SettingsPageLayout>
  );
}
