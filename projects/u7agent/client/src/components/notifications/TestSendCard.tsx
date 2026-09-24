import { notificationResultView, resultMetaLabel, resultTimeLabel } from "../../lib/notifications";
import type { NotificationResult } from "../../types";
import { CheckIcon, RunSpinnerIcon, WarningIcon } from "../icons";
import { NotificationCard } from "./NotificationCard";

export type TestSendCardProps = {
  /** 保存済み URL があるか (未保存の変更があるときは、保存後の値で判定した結果) */
  available: boolean;
  /** URL に未保存の変更がある。押すと保存してから送る */
  needsSave: boolean;
  saving: boolean;
  testing: boolean;
  lastResult?: NotificationResult;
  onTest: () => void;
};

/**
 * テスト送信。保存済み設定で 1 通送る (通知の有効 / 無効には関係しない)。
 * 直近結果は通常通知と共通の 1 件で、URL とレスポンス原文は出さない。
 */
export function TestSendCard({ available, needsSave, saving, testing, lastResult, onTest }: TestSendCardProps) {
  const view = notificationResultView(lastResult);
  const label = needsSave ? "保存してテスト" : "テスト送信";
  const meta = testing ? `${resultTimeLabel(Date.now())} / 送信中` : lastResult ? resultMetaLabel(lastResult) : "";
  return (
    <NotificationCard title="テスト送信">
      <p className="text-2xs leading-relaxed text-ink-ghost">
        送信先のチャンネルにテストメッセージを 1 通送ります。通知の有効 / 無効に関係なく実行できます。
      </p>
      {needsSave ? (
        <p className="text-2xs leading-relaxed text-warn">
          未保存の変更があります。テストすると保存してから送信します。
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn-primary" disabled={!available || testing || saving} onClick={onTest}>
          {testing ? <RunSpinnerIcon tone="on-accent" /> : null}
          {testing ? "送信中…" : label}
        </button>
        {!available ? (
          <span className="text-2xs leading-4 break-words text-ink-ghost">
            Webhook URL を保存するとテストできます。
          </span>
        ) : null}
      </div>
      {testing || lastResult ? (
        <div className="grid gap-1 border-t border-line pt-2 text-2xs">
          <div className="text-ink-muted">直近の結果 {meta}</div>
          {!testing && view ? (
            <div className={view.ok ? "flex items-start gap-1.5 text-ok" : "flex items-start gap-1.5 text-warn"}>
              <span className="mt-0.5">{view.ok ? <CheckIcon /> : <WarningIcon />}</span>
              <span className="min-w-0">
                <span className="break-words">{view.headline}</span>
                {view.detail ? <span className="block leading-relaxed text-ink-ghost">{view.detail}</span> : null}
              </span>
            </div>
          ) : null}
        </div>
      ) : null}
    </NotificationCard>
  );
}
