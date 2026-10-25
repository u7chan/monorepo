import type { ArchiveSettings } from "../hooks/useArchiveSettings";
import { ExcludeNamesEditor } from "./ExcludeNamesEditor";

export type ArchiveExcludeSettingsProps = {
  /** 除外名の state と操作。追加済みの下書きは facade が持つ */
  archiveSettings: ArchiveSettings;
  /** 追加前の入力。本文はタブ切替で unmount されるため、親 (FileTreePage) が持つ */
  input: string;
  onInputChange: (value: string) => void;
  onSubmit: () => void;
  /** 設定 → 共有「公開の除外」へ移る（公開の除外との違いを文言で示す導線） */
  onOpenSharingExclusions: () => void;
};

/**
 * 設定 → ファイル「ダウンロードの除外」タブの中身。ヘッダと操作行、下書き以外の入力 state は `FileTreePage` が持つ。
 * 一覧エディタは共有の「公開の除外」と同じ部品で、ここではダウンロード向けの規則と警告だけを渡す。
 */
export function ArchiveExcludeSettings({
  archiveSettings,
  input,
  onInputChange,
  onSubmit,
  onOpenSharingExclusions,
}: ArchiveExcludeSettingsProps) {
  const { settings, draft, note, remove } = archiveSettings;

  return (
    <ExcludeNamesEditor
      settings={settings}
      draft={draft}
      note={note}
      subject="ダウンロードの除外名"
      inputLabel="除外する名前"
      placeholder="node_modules"
      input={input}
      onInputChange={onInputChange}
      onSubmit={onSubmit}
      onRemove={remove}
      hint={
        <p className="rounded-lg border border-line bg-soft p-3 text-2xs leading-relaxed text-ink-soft">
          ここはファイルツリーから ZIP でダウンロードするときに落とす名前です。Cloudflare
          へ公開するときの除外とは別の一覧で、既定値も適用先も違います。
          <button type="button" className="btn-quiet ml-1.5" onClick={onOpenSharingExclusions}>
            公開の除外を開く
          </button>
        </p>
      }
      rules={
        <ul className="grid gap-1 text-2xs leading-relaxed text-ink-soft">
          <li>名前はベース名の完全一致で、階層を問わずすべての階層に当たります（パス指定や glob は使えません）。</li>
          <li>symlink は一覧に関係なく常に ZIP の対象外です。</li>
          <li>ここに挙げた名前を除いた ZIP になるため、ビルド成果物と依存は既定で入りません。</li>
          <li>
            一覧を保存すると上書きになり、以後のアプリ更新で既定が増えてもこの一覧は変わりません（既定に戻すと追随します）。
          </li>
        </ul>
      }
      emptySummary="除外なし。node_modules なども ZIP に入るため、失敗しやすくなります。"
      emptyBody={
        <p>
          除外なし。node_modules なども ZIP に入るため、100 MiB
          の上限に届いて失敗しやすくなります。ビルド成果物と依存を落とすなら既定に戻してください。
        </p>
      }
    />
  );
}
