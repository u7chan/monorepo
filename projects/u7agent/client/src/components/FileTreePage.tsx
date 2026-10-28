import { useEffect, useRef, useState } from "react";
import type { ArchiveSettings } from "../hooks/useArchiveSettings";
import { cn } from "../lib/cn";
import { normalizeFileTreeRoot } from "../lib/fileTree";
import { DEFAULT_FILES_SUBSECTION, FILES_SUBSECTIONS, type FilesSubsection } from "../lib/settingsNav";
import { UNSAVED_RELOAD_NOTE } from "../lib/settingsNotes";
import { ArchiveExcludeSettings } from "./ArchiveExcludeSettings";
import { FileBrowser } from "./FileBrowser";
import { FileBrowserScrollArea } from "./FileBrowserScrollArea";
import { CheckIcon } from "./icons";
import { ReloadButton } from "./ReloadButton";
import { SettingsPageLayout, type SettingsPageProps } from "./SettingsPageLayout";
import { TabToolbar } from "./TabToolbar";

export type FileTreePageProps = SettingsPageProps & {
  /** ワークスペース root 相対 ("" や絶対パスは root へ畳まれる) */
  cwd: string;
  /** ワークスペース root の絶対パス (health.cwd)。行の絶対パスのコピーに使う (未取得の "" では出さない) */
  rootCwd?: string;
  /** アーカイブの除外名の実効値（app 状態）。行のダウンロードの出し分けに使う */
  excludeNames: readonly string[];
  /** プレビュー オリジンのブラウザから見たポート (health)。未取得は undefined */
  filePreviewPort?: number;
  /** 「ダウンロードの除外」タブの中身。下書き / 保存の状態は facade が持つ */
  archiveSettings: ArchiveSettings;
  /** URL が決めるタブ。既定はファイルツリー (lib/settingsNav.ts) */
  filesSubsection?: FilesSubsection;
  onSelectFilesSubsection: (subsection: FilesSubsection) => void;
  /** 設定 → 共有「公開の除外」へ移る（ダウンロードの除外との違いを示す導線） */
  onOpenSharingExclusions: () => void;
};

/**
 * 設定 → ファイル。root は選択中セッション / プロジェクトに追随させず、常にワークスペース root (`cwd=""`) に
 * 固定する (同じ画面が選択状態で別の場所を指すと、今どこを見ているか分からなくなる)。ツリーとプレビューの本体は
 * `FileBrowser` で、チャットの右パネル (`SessionFilesPanel`) と共有する。ヘッダは画面幅いっぱいに使う。
 *
 * ダウンロードの除外はツリーの行のダウンロード導線と対になる設定なので、独立したセクションにせず、同じ画面の
 * タブ (`/settings/files/archive`) に置く (hook / API が別でも対象は同じ。lib/settingsNav.ts のタブの規則)。
 */
export function FileTreePage({
  cwd,
  rootCwd,
  excludeNames,
  filePreviewPort,
  archiveSettings,
  filesSubsection = DEFAULT_FILES_SUBSECTION,
  onSelectFilesSubsection,
  onOpenSharingExclusions,
  singleColumn = false,
  onBack,
  onOpenNav,
}: FileTreePageProps) {
  // root が固定なので key は不要 (root が変わる画面は呼び出し側で FileBrowser を張り替える)
  const rootPath = normalizeFileTreeRoot(cwd);
  const [reloadToken, setReloadToken] = useState(0);
  // 追加前の入力はタブの親が持つ。本文はタブ切替で unmount されるため、子に置くと入力中の名前が消える
  const [excludeInput, setExcludeInput] = useState("");
  const archive = filesSubsection === "archive";
  const { settings, dirty, saving, reloading, note, save, reset, discard } = archiveSettings;
  const submitExcludeInput = () => {
    // 追加できなかったときは入力を残す（上限や重複の理由をその場で直せるように）
    if (archiveSettings.add(excludeInput)) setExcludeInput("");
  };
  const activeTabRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (singleColumn) activeTabRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [singleColumn, filesSubsection]);
  /** 下書きを捨てる再読み込みが押せない理由。変更が無い間は出さない */
  const unsavedReloadNote = archive && dirty ? UNSAVED_RELOAD_NOTE : null;
  // 操作はタブごとに変える (ツリーは今の一覧の取り直し、除外は下書きの保存)
  const actions = archive ? (
    <>
      {/* 再読み込みは下書きを捨てるので、変更がある間は押せない (理由の置き場は下の caption / context) */}
      <ReloadButton onClick={() => void archiveSettings.reload()} disabled={dirty || reloading}>
        再読み込み
      </ReloadButton>
      <span aria-hidden="true" className="h-4 w-px bg-line" />
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
  ) : (
    <ReloadButton onClick={() => setReloadToken((token) => token + 1)}>再読み込み</ReloadButton>
  );

  return (
    <SettingsPageLayout
      eyebrow="FILES"
      title="ファイル"
      // ツリーの root は常にワークスペース root ("/") で、面を選ぶ情報にならないため caption を出さない
      caption={
        archive ? (
          <>
            ダウンロードから除外する名前を決めます。
            {/* singleColumn の帯は操作だけで埋まり、理由が 1 文字幅まで潰れる。ヘッダ側で折り返して読ませる */}
            {singleColumn && unsavedReloadNote ? (
              <div className="pt-0.5 text-2xs text-ink-muted">{unsavedReloadNote}</div>
            ) : null}
          </>
        ) : undefined
      }
      toolbar={
        <TabToolbar
          context={
            !singleColumn && unsavedReloadNote ? (
              <span className="text-2xs text-ink-muted">{unsavedReloadNote}</span>
            ) : undefined
          }
          actions={actions}
        />
      }
      tabs={
        <div
          role="tablist"
          aria-label="ファイルの設定"
          className={cn(
            "flex min-w-0 shrink-0 gap-1 overflow-x-auto border-b border-line",
            singleColumn ? "px-2" : "px-4",
          )}
        >
          {FILES_SUBSECTIONS.map((item) => (
            <button
              key={item.subsection}
              ref={filesSubsection === item.subsection ? activeTabRef : undefined}
              type="button"
              role="tab"
              aria-selected={filesSubsection === item.subsection}
              onClick={() => onSelectFilesSubsection(item.subsection)}
              className={cn(
                "tab-item shrink-0 whitespace-nowrap",
                singleColumn && "px-1.5",
                filesSubsection === item.subsection && "tab-item-active",
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
      }
      // 除外タブの読み込み / 保存の注記。ツリーは行にエラーを出すため note を持たない
      note={archive ? note : undefined}
      singleColumn={singleColumn}
      onOpenNav={onOpenNav}
      onBack={onBack}
    >
      {archive ? (
        <ArchiveExcludeSettings
          archiveSettings={archiveSettings}
          input={excludeInput}
          onInputChange={setExcludeInput}
          onSubmit={submitExcludeInput}
          onOpenSharingExclusions={onOpenSharingExclusions}
        />
      ) : (
        <FileBrowserScrollArea>
          <FileBrowser
            root={rootPath}
            rootCwd={rootCwd}
            reloadToken={reloadToken}
            canRename
            excludeNames={excludeNames}
            filePreviewPort={filePreviewPort}
          />
        </FileBrowserScrollArea>
      )}
    </SettingsPageLayout>
  );
}
