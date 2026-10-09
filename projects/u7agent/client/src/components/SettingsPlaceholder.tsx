import { ReloadButton } from "./ReloadButton";

/** 取得前の本文。読み込み中と取得失敗で同じ枠を使い、失敗のときだけ再読み込みの導線を出す */
export function SettingsPlaceholder({
  label,
  note,
  reloading,
  onReload,
}: {
  label: string;
  note: { text: string; error: boolean };
  reloading: boolean;
  onReload: () => void;
}) {
  return (
    <div className="min-h-0 min-w-0 scrollbar-thin overflow-x-hidden overflow-y-auto px-4 py-4">
      <div className="mx-auto grid max-w-3xl gap-3">
        <div className="grid justify-items-start gap-2 rounded-lg border border-line bg-soft p-3 text-xs text-ink-muted">
          {note.error ? (
            <>
              <p role="alert">{label}を読み込めませんでした。</p>
              <ReloadButton onClick={onReload} disabled={reloading}>
                再読み込み
              </ReloadButton>
            </>
          ) : (
            <p role="status">{label}を読み込んでいます。</p>
          )}
        </div>
      </div>
    </div>
  );
}
