export type ImportPreviewEntry = { label: string; detail: string };

export type ImportPreviewCardProps = {
  fileName: string;
  entries: ImportPreviewEntry[];
  /** ファイルに含まれない = 変更しない対象 */
  untouched: string[];
  onCancel: () => void;
  onConfirm: () => void;
};

/**
 * ファイルを選んだ直後の確認。取り込む範囲はファイルの中身で決まるため、
 * どの対象が置き換わるかを適用前にここで示す (チェックの状態とは無関係であることも読み取れる)。
 */
export function ImportPreviewCard({ fileName, entries, untouched, onCancel, onConfirm }: ImportPreviewCardProps) {
  return (
    <div className="grid gap-3 rounded-lg border border-line bg-soft px-3 py-3">
      <div className="grid gap-1">
        <div className="text-2xs font-semibold tracking-label text-ink-faint uppercase">取り込む内容</div>
        <div className="min-w-0 truncate text-xs text-ink">{fileName}</div>
      </div>
      <ul className="grid gap-1.5">
        {entries.map((entry) => (
          <li key={entry.label} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-2xs text-ink-soft">
            <span className="text-xs text-ink">{entry.label}</span>
            <span>{entry.detail} に置き換え</span>
          </li>
        ))}
      </ul>
      {untouched.length > 0 ? (
        <p className="text-2xs leading-relaxed text-ink-ghost">変更しない対象: {untouched.join(" / ")}</p>
      ) : null}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <button type="button" onClick={onCancel} className="btn-quiet">
          やめる
        </button>
        <button type="button" onClick={onConfirm} className="btn-primary">
          取り込む
        </button>
      </div>
    </div>
  );
}
