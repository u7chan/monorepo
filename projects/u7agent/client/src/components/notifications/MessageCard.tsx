import { NotificationCard } from "./NotificationCard";

export type MessageCardProps = {
  previewLines: string[];
};

/** 通知メッセージのプレビュー。本文はサーバーが組み立てるため、ここは形の確認だけ */
export function MessageCard({ previewLines }: MessageCardProps) {
  return (
    <NotificationCard title="メッセージ">
      <div className="grid gap-1">
        <span className="text-2xs text-ink-faint">プレビュー</span>
        <div className="grid gap-0.5 rounded-lg border border-line bg-raised px-2.5 py-2 text-xs leading-relaxed text-ink-soft">
          {previewLines.map((line) => (
            <span key={line} className="break-words">
              {line}
            </span>
          ))}
        </div>
      </div>
    </NotificationCard>
  );
}
