import { cn } from "../lib/cn";

/**
 * 設定ページの結果通知 (aria-live)。ページ下部と詳細の固定フッターで同じ見た目を使う。
 * **1 画面で出す場所は 1 箇所だけ**にする (静的ヒントと結果を二重に積まない)。
 */
export function SettingsNoteRow({
  note,
  inset = false,
}: {
  note: { text: string; error: boolean };
  /** 詳細の固定フッターに置くときの左右の余白 */
  inset?: boolean;
}) {
  return (
    <div
      aria-live="polite"
      className={cn(
        "border-t border-line text-1xs break-words",
        inset ? "px-4 py-2.5" : "px-5 py-2.5",
        note.error ? "text-danger-text" : "text-ink-muted",
      )}
    >
      {note.text}
    </div>
  );
}
