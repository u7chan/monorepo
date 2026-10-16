import { RELOAD_ABOVE_NOTE } from "../lib/settingsNotes";

/** 取得前の本文。読み込み中と取得失敗で同じ枠を使い、失敗のときは取り直す場所だけを案内する */
export function SettingsPlaceholder({ label, note }: { label: string; note: { text: string; error: boolean } }) {
  return (
    <div className="min-h-0 min-w-0 scrollbar-thin overflow-x-hidden overflow-y-auto px-4 py-4">
      <div className="mx-auto grid max-w-3xl gap-3">
        <div className="grid justify-items-start gap-2 rounded-lg border border-line bg-soft p-3 text-xs text-ink-muted">
          {note.error ? (
            <>
              <p role="alert">{label}を読み込めませんでした。</p>
              <p>{RELOAD_ABOVE_NOTE}</p>
            </>
          ) : (
            <p role="status">{label}を読み込んでいます。</p>
          )}
        </div>
      </div>
    </div>
  );
}
