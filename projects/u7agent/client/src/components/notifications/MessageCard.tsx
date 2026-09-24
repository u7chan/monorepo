import type { NotificationMention } from "../../types";
import { SelectField } from "../SelectField";
import { NotificationCard } from "./NotificationCard";

export type MessageCardProps = {
  mention: NotificationMention;
  previewLines: string[];
  onChangeMention: (mention: NotificationMention) => void;
};

/** メンションと本文のプレビュー。本文はサーバーが組み立てるため、ここは形の確認だけ */
export function MessageCard({ mention, previewLines, onChangeMention }: MessageCardProps) {
  return (
    <NotificationCard title="メッセージ">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-2xs text-ink-soft">メンション</span>
        <SelectField
          density="sm"
          value={mention}
          aria-label="メンション"
          onChange={(event) => onChangeMention(event.currentTarget.value as NotificationMention)}
        >
          <option value="none">なし</option>
          <option value="here">@here</option>
        </SelectField>
      </div>
      <p className="text-2xs leading-relaxed text-ink-ghost">
        本文に含まれる @everyone やロールメンションは送られません。
      </p>
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
