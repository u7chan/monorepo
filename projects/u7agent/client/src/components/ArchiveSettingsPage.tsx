import { useState } from "react";
import type { ArchiveSettings } from "../hooks/useArchiveSettings";
import { CollapsibleNotice } from "./CollapsibleNotice";
import { CheckIcon, PlusIcon, TrashIcon } from "./icons";
import { ReloadButton } from "./ReloadButton";
import { SettingsPageLayout, type SettingsPageProps } from "./SettingsPageLayout";

export type ArchiveSettingsPageProps = SettingsPageProps & {
  archiveSettings: ArchiveSettings;
};

/** 設定 → アーカイブ。編集は下書きで、[保存] で一覧を丸ごと PUT する（[既定に戻す] は行を消す DELETE） */
export function ArchiveSettingsPage({ archiveSettings, compact = false, onBack, onOpenNav }: ArchiveSettingsPageProps) {
  const { settings, draft, dirty, saving, note, add, remove, reload, save, reset, discard } = archiveSettings;
  const [input, setInput] = useState("");

  const submit = () => {
    // 追加できなかったときは入力を残す（上限や重複の理由をその場で直せるように）
    if (add(input)) setInput("");
  };

  return (
    <SettingsPageLayout
      eyebrow="ARCHIVE"
      title="アーカイブの除外"
      caption="ファイルツリーのダウンロード（フォルダは ZIP）から落とす名前を決めます。"
      actions={
        <>
          <button type="button" className="btn-quiet" disabled={!dirty || saving} onClick={discard}>
            破棄
          </button>
          <button
            type="button"
            className="btn-quiet"
            disabled={!settings?.overridden || saving}
            onClick={() => void reset()}
          >
            既定に戻す
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
                    submit();
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
                    onChange={(event) => setInput(event.currentTarget.value)}
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
                  <p role="alert">アーカイブの除外名を読み込めませんでした。</p>
                  <ReloadButton onClick={() => void reload()}>再読み込み</ReloadButton>
                </>
              ) : (
                <p role="status">アーカイブの除外名を読み込んでいます。</p>
              )}
            </div>
          )}
        </div>
      </div>
    </SettingsPageLayout>
  );
}
