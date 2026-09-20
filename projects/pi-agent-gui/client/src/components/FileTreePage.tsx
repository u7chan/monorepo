import { useState } from "react";
import { FILE_TREE_ROOT, normalizeFileTreeRoot } from "../lib/fileTree";
import { FileBrowser } from "./FileBrowser";
import { SettingsPageLayout, type SettingsPageProps } from "./SettingsPageLayout";
import { RefreshIcon } from "./icons";

export type FileTreePageProps = SettingsPageProps & {
  /** ワークスペース root 相対 ("" や絶対パスは root へ畳まれる) */
  cwd: string;
};

/**
 * 設定 → ファイル。root は選択中セッション / プロジェクトに追随させず、常にワークスペース root (`cwd=""`) に
 * 固定する (同じ画面が選択状態で別の場所を指すと、今どこを見ているか分からなくなる)。ツリーとプレビューの本体は
 * `FileBrowser` で、チャットの右パネル (`SessionFilesPanel`) と共有する。ヘッダは画面幅いっぱいに使う。
 */
export function FileTreePage({ cwd, compact = false, onBack, onOpenNav }: FileTreePageProps) {
  // root が固定なので key は不要 (root が変わる画面は呼び出し側で FileBrowser を張り替える)
  const rootPath = normalizeFileTreeRoot(cwd);
  const [reloadToken, setReloadToken] = useState(0);

  return (
    <SettingsPageLayout
      eyebrow="WORKSPACE"
      title="ワークスペース"
      // 表示も root 相対に揃える。ワークスペース root は "/" で示す (tree の起点と一致させる)
      caption={
        <code className="block truncate text-1xs leading-normal text-ink-muted">
          {rootPath === FILE_TREE_ROOT ? "/" : rootPath}
        </code>
      }
      compact={compact}
      onOpenNav={onOpenNav}
      onBack={onBack}
      actions={
        <button type="button" onClick={() => setReloadToken((token) => token + 1)} className="btn-quiet">
          <RefreshIcon />
          再読み込み
        </button>
      }
    >
      {/* ワークスペース root は常に読み取り専用 (削除はチャット右パネルのセッション作業フォルダだけ) */}
      <FileBrowser root={rootPath} reloadToken={reloadToken} canDelete={false} />
    </SettingsPageLayout>
  );
}
