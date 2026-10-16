import type { ArchiveSettings } from "../hooks/useArchiveSettings";
import { RELOAD_ABOVE_NOTE } from "../lib/settingsNotes";
import { CollapsibleNotice } from "./CollapsibleNotice";
import { PlusIcon, TrashIcon } from "./icons";

export type ArchiveExcludeSettingsProps = {
  /** 除外名の state と操作。追加済みの下書きは facade が持つ */
  archiveSettings: ArchiveSettings;
  /** 追加前の入力。本文はタブ切替で unmount されるため、親 (FileTreePage) が持つ */
  input: string;
  onInputChange: (value: string) => void;
  onSubmit: () => void;
};

/** 設定 → ファイル「ダウンロードの除外」タブの中身。ヘッダと操作行、下書き以外の入力 state は `FileTreePage` が持つ */
export function ArchiveExcludeSettings({
  archiveSettings,
  input,
  onInputChange,
  onSubmit,
}: ArchiveExcludeSettingsProps) {
  const { settings, draft, note, remove } = archiveSettings;

  return (
    <div className="min-h-0 min-w-0 scrollbar-thin overflow-x-hidden overflow-y-auto px-4 py-4">
      <div className="mx-auto grid max-w-3xl gap-3">
        {settings ? (
          <>
            <section className="grid gap-2 rounded-lg border border-line bg-soft p-3">
              <h3 className="text-2xs font-semibold tracking-label text-ink-faint uppercase">除外の規則</h3>
              <ul className="grid gap-1 text-2xs leading-relaxed text-ink-soft">
                <li>
                  名前はベース名の完全一致で、階層を問わずすべての階層に当たります（パス指定や glob は使えません）。
                </li>
                <li>symlink は一覧に関係なく常に ZIP の対象外です。</li>
                <li>ここに挙げた名前を除いた ZIP になるため、ビルド成果物と依存は既定で入りません。</li>
                <li>
                  一覧を保存すると上書きになり、以後のアプリ更新で既定が増えてもこの一覧は変わりません（既定に戻すと追随します）。
                </li>
              </ul>
            </section>

            <section className="grid gap-2 rounded-lg border border-line bg-soft p-3">
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                <h3 className="flex min-w-0 items-center gap-1.5 text-2xs font-semibold tracking-label text-ink-faint uppercase">
                  除外する名前
                  <span className="rounded border border-line px-1.5 py-0.5 text-2xs font-normal tracking-normal text-ink-muted normal-case">
                    {settings.overridden ? "上書き中" : "既定の一覧を使用中"}
                  </span>
                </h3>
                <span className="text-2xs text-ink-muted">
                  {draft.excludeNames.length} / {settings.maxNames}
                </span>
              </div>

              <form
                className="flex flex-wrap items-center gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  onSubmit();
                }}
              >
                <input
                  className="field min-w-0 flex-1 text-xs"
                  type="text"
                  value={input}
                  placeholder="node_modules"
                  aria-label="除外する名前"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => onInputChange(event.currentTarget.value)}
                />
                <button type="submit" className="btn-quiet">
                  <PlusIcon />
                  追加
                </button>
              </form>

              {draft.excludeNames.length === 0 ? (
                <CollapsibleNotice summary="除外なし。node_modules なども ZIP に入るため、失敗しやすくなります。">
                  <p>
                    除外なし。node_modules なども ZIP に入るため、100 MiB
                    の上限に届いて失敗しやすくなります。ビルド成果物と依存を落とすなら既定に戻してください。
                  </p>
                </CollapsibleNotice>
              ) : (
                <ul className="grid min-w-0 gap-0.5">
                  {draft.excludeNames.map((name) => (
                    <li
                      key={name}
                      className="-mx-1.5 flex min-h-6.5 min-w-0 items-center gap-2 rounded-md px-1.5 transition-colors hover:bg-hover"
                    >
                      <code className="min-w-0 flex-1 truncate text-xs text-ink" title={name}>
                        {name}
                      </code>
                      <button
                        type="button"
                        className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-md text-ink-soft transition-colors hover:bg-raised hover:text-danger"
                        aria-label={`${name} を除外から外す`}
                        title="除外から外す"
                        onClick={() => remove(name)}
                      >
                        <TrashIcon />
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              <p className="text-2xs leading-relaxed text-ink-ghost">
                名前は 1 セグメント（<code>/</code>を含まない）で {settings.maxNameLength} 文字まで、
                {settings.maxNames} 件までです。既定の一覧は {settings.defaultExcludeNames.length} 件です。
              </p>
            </section>
          </>
        ) : (
          <div className="grid justify-items-start gap-2 rounded-lg border border-line bg-soft p-3 text-xs text-ink-muted">
            {note.error ? (
              <>
                <p role="alert">ダウンロードの除外名を読み込めませんでした。</p>
                <p>{RELOAD_ABOVE_NOTE}</p>
              </>
            ) : (
              <p role="status">ダウンロードの除外名を読み込んでいます。</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
