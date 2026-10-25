import type { SharedContentExclusionsSettings } from "../../hooks/useSharedContentExclusions";
import { ExcludeNamesEditor } from "../ExcludeNamesEditor";

export type SharedContentExclusionsTabProps = {
  /** 公開の除外名の state と操作。追加済みの下書きは facade が持つ */
  exclusions: SharedContentExclusionsSettings;
  /** 追加前の入力。本文はタブ切替で unmount されるため、親 (SharingSettingsPage) が持つ */
  input: string;
  onInputChange: (value: string) => void;
  onSubmit: () => void;
  /** 設定 → ファイル「ダウンロードの除外」へ移る */
  onOpenArchiveExclusions: () => void;
};

/**
 * 設定 → 共有「公開の除外」タブの中身。ダウンロードの除外と同じ一覧エディタを使い、
 * 公開だけの規則（対象ディレクトリ自身の名前は落とす / `index.html` は除外できない）と、
 * ダウンロードの除外との違いを文言で示す。
 */
export function SharedContentExclusionsTab({
  exclusions,
  input,
  onInputChange,
  onSubmit,
  onOpenArchiveExclusions,
}: SharedContentExclusionsTabProps) {
  const { settings, draft, note, remove } = exclusions;

  return (
    <ExcludeNamesEditor
      settings={settings}
      draft={draft}
      note={note}
      subject="公開の除外名"
      inputLabel="公開から除外する名前"
      placeholder="AGENTS.md"
      input={input}
      onInputChange={onInputChange}
      onSubmit={onSubmit}
      onRemove={remove}
      hint={
        <p className="rounded-lg border border-line bg-soft p-3 text-2xs leading-relaxed text-ink-soft">
          ここは Cloudflare へ公開する ZIP から落とす名前です。ダウンロード（ファイルツリーの
          ZIP）から落とす名前とは別の一覧で、既定値も 適用先も違います。
          <button type="button" className="btn-quiet ml-1.5" onClick={onOpenArchiveExclusions}>
            ダウンロードの除外を開く
          </button>
        </p>
      }
      rules={
        <ul className="grid gap-1 text-2xs leading-relaxed text-ink-soft">
          <li>名前はベース名の完全一致で、階層を問わずすべての階層に当たります（パス指定や glob は使えません）。</li>
          <li>symlink は一覧に関係なく常に公開の対象外です。</li>
          <li>
            対象ディレクトリ自身の名前と同じ除外名は、その共有では使いません（<code>dist</code>
            を除外していても、<code>dist/</code> は共有できます）。
          </li>
          <li>
            <code>index.html</code> は公開に必要なため除外できません。名前は全階層に当たるので、入れ子の
            <code>index.html</code> も同じく除外できません。
          </li>
          <li>
            除外は事故防止で、秘匿の保証ではありません。既知の秘密値の検査は変わらず、含まれていれば公開は失敗します。
          </li>
          <li>
            一覧を保存すると上書きになり、以後のアプリ更新で既定が増えてもこの一覧は変わりません（既定に戻すと追随します）。
          </li>
        </ul>
      }
      emptySummary="除外なし。AGENTS.md や .env も公開されます。"
      emptyBody={
        <p>
          除外なし。AGENTS.md / README.md のようなリポジトリの指示と説明、.env
          のような秘密値を持ちやすいファイルも公開対象になります。落とすなら既定に戻してください。
        </p>
      }
    />
  );
}
