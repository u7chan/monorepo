import type { Notifications } from "../hooks/useNotifications";
import { notificationPreviewLines, testAvailable, testNeedsSave } from "../lib/notifications";
import { RELOAD_ABOVE_NOTE, UNSAVED_RELOAD_NOTE } from "../lib/settingsNotes";
import { CheckIcon } from "./icons";
import { DiscordCard } from "./notifications/DiscordCard";
import { LinkCard } from "./notifications/LinkCard";
import { MessageCard } from "./notifications/MessageCard";
import { QuestionCard } from "./notifications/QuestionCard";
import { TestSendCard } from "./notifications/TestSendCard";
import { ReloadButton } from "./ReloadButton";
import { SettingsPageLayout, type SettingsPageProps } from "./SettingsPageLayout";
import { TabToolbar } from "./TabToolbar";

export type NotificationSettingsPageProps = SettingsPageProps & {
  notifications: Notifications;
};

/** 設定 → 通知。編集はすべて下書きで、[保存] でまとめて PUT する */
export function NotificationSettingsPage({
  notifications,
  singleColumn = false,
  onBack,
  onOpenNav,
}: NotificationSettingsPageProps) {
  const { settings, draft, setDraft, dirty, saving, testing, reloading, note, reload, save, test, discard } =
    notifications;
  const needsSave = testNeedsSave(draft);

  return (
    <SettingsPageLayout
      eyebrow="NOTIFICATIONS"
      title="通知"
      caption={
        <>
          通知の送信先と、通知する内容を設定します。
          {/* 再読み込みは下書きを捨てるので、変更がある間は押せない (理由をこの行に出す) */}
          {dirty ? <div className="pt-0.5 text-2xs text-ink-muted">{UNSAVED_RELOAD_NOTE}</div> : null}
        </>
      }
      toolbar={
        <TabToolbar
          actions={
            <>
              <ReloadButton onClick={() => void reload()} disabled={dirty || reloading}>
                再読み込み
              </ReloadButton>
              <span aria-hidden="true" className="h-4 w-px bg-line" />
              <button type="button" className="btn-quiet" disabled={!dirty || saving} onClick={discard}>
                破棄
              </button>
              <button type="button" className="btn-primary" disabled={!dirty || saving} onClick={() => void save()}>
                <CheckIcon />
                保存
              </button>
            </>
          }
        />
      }
      note={note}
      singleColumn={singleColumn}
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
              <QuestionCard askUser={draft.askUser} onChangeAskUser={(askUser) => setDraft({ askUser })} />
              <TestSendCard
                available={testAvailable(draft, settings)}
                needsSave={needsSave}
                saving={saving}
                testing={testing}
                lastResult={settings.lastResult}
                onTest={() => void test(needsSave)}
              />
              <LinkCard value={draft.baseUrl} onChange={(baseUrl) => setDraft({ baseUrl })} />
              <MessageCard previewLines={notificationPreviewLines(draft)} />
            </>
          ) : (
            <div className="grid justify-items-start gap-2 rounded-lg border border-line bg-soft p-3 text-xs text-ink-muted">
              {note.error ? (
                <>
                  <p role="alert">通知の設定を読み込めませんでした。</p>
                  <p>{RELOAD_ABOVE_NOTE}</p>
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
