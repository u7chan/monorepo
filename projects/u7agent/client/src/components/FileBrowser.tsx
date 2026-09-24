import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  deleteDirectory,
  deleteFile,
  fileDownloadUrl,
  getFileDownloadCheck,
  getFiles,
  getHealth,
  renameEntry,
} from "../api";
import { FilePreview } from "./FilePreview";
import { cn } from "../lib/cn";
import { archiveConfirmMessage, isArchiveExcludedName, startArchiveDownload } from "../lib/archive";
import {
  applyFileTreeError,
  applyFileTreeListing,
  beginFileTreeLoad,
  createFileTreeStateFromDirectories,
  FILE_TREE_ROOT,
  fileTreeChildPath,
  fileTreeDeleteConfirm,
  fileTreeDeleteDirectoryConfirm,
  fileTreeDirectoryState,
  fileTreeFetchPath,
  fileTreeParentPath,
  fileTreeRenamePrompt,
  invalidateFileTree,
  normalizeFileTreeRoot,
  openFileTreeDirectories,
  pendingFileTreeDirectories,
  pruneFileTreeSubtree,
  removeFileTreeEntry,
  renameFileTreeEntry,
  toggleFileTreeDirectory,
  type FileTreeDirectoryState,
  type FileTreeState,
} from "../lib/fileTree";
import { fileKind } from "../lib/fileKind";
import { type FileRefRequest } from "../lib/fileRefRequest";
import { filePreviewStore } from "../lib/filePreviewState";
import { messageFullTimeLabel, messageTimeLabel } from "../lib/messageTime";
import {
  closeFileTab,
  closeFileTabsUnder,
  dropClosedPreviewModes,
  openFileTab,
  renameFileTabs,
  renamePreviewModes,
  restoreFileTabsState,
  withPreviewMode,
  type FileTabsState,
  type PreviewMode,
  type PreviewModes,
} from "../lib/fileTabs";
import type { FileEntry } from "../types";
import { ChevronIcon, DownloadIcon, FileIcon, FolderIcon, PencilIcon, TrashIcon } from "./icons";

const INDENT = 16;
/** ファイル行の左端。親の chevron (16) + gap-2 (8) + ディレクトリ行の左端 (8) と一致させる */
const FILE_INDENT = 32;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type FileBrowserProps = {
  /** ワークスペース root 相対 ("" や絶対パスは root へ畳まれる) */
  root: string;
  /** 値を変えると一覧と開いている本文を取り直す。mount 時の値では撃たない */
  reloadToken: number;
  /** フォルダ行にリネームの鉛筆を出すか。既定 false (チャット右パネルでは出さない) */
  canRename?: boolean;
  /** 削除とリネームの導線を出さない (読み取り専用の面)。既定 false (既存 2 画面は不変) */
  readOnly?: boolean;
  /** 未消費の「ファイル参照から開く」要求。適用したら onHandled(seq) で App へ返す */
  openRequest?: FileRefRequest | null;
  onHandled?: (seq: number) => void;
};

/**
 * ファイルツリーとプレビューの本体。渡された `root` を起点に `GET /api/files` を辿る (配下は `<root>/<name>`)。
 * 外装 (設定ページ / チャットの右パネル) は呼び出し側が持ち、root の違う 2 画面で同じ実装を使う。
 * **root を変えるときは呼び出し側で `key` を張り替える** (復元・取得・保存は mount ごとの初期化が前提)。
 * 行は深さに比例したインデントだけを持ち、長い名前は truncate して横スクロールを出さない。
 * ディレクトリは展開時に初めて取得し、ファイル監視はしない (一覧も行の時刻も「再読み込み」と run 終了でしか更新されない)。
 */
export function FileBrowser({
  root,
  reloadToken,
  canRename = false,
  readOnly = false,
  openRequest,
  onHandled,
}: FileBrowserProps) {
  const rootPath = normalizeFileTreeRoot(root);
  // 復元は mount ごとに 1 回。lazy initializer に置くことで、復元前の空状態を取得や保存の Effect が見ない
  // (StrictMode で初期化が 2 回走っても同じ snapshot から同じ状態になる)
  const [restored] = useState(() => filePreviewStore.read(rootPath));
  const [tree, setTree] = useState<FileTreeState>(() => createFileTreeStateFromDirectories(restored?.dirs ?? []));
  const [tabs, setTabs] = useState<FileTabsState>(() =>
    restoreFileTabsState(restored?.paths ?? [], restored?.active ?? null),
  );
  // 一覧の再読み込みでプレビュー本文も捨てる (開いているタブは保つ)
  const [previewVersion, setPreviewVersion] = useState(0);
  // 表示モードは再読み込みの remount を跨ぐ必要がある (選択はタブを閉じるまで保持する) ため親が持つ (docs/file-preview.md)
  const [previewModes, setPreviewModes] = useState<PreviewModes>(() => restored?.modes ?? {});
  // StrictMode の effect 二重実行と、取得中の再読み込みで同じディレクトリを二重に要求しない
  const inFlightRef = useRef<Set<string>>(new Set());
  // 同じ行の削除を二重に送らない (実体が消えた後の再要求で 404 を出さないため)
  const deletingRef = useRef<Set<string>>(new Set());
  // 同じ行のリネームを二重に送らない (削除と同じ理由)
  const renamingRef = useRef<Set<string>>(new Set());
  // 同じ行のダウンロードを二重に始めない (確認ダイアログが二重に出ないように)
  const downloadingRef = useRef<Set<string>>(new Set());
  /** 除外規則の実効値 (health の `archive.excludeNames`)。取れなかったら空のままにし、判定はサーバーの check に任せる */
  const [excludeNames, setExcludeNames] = useState<readonly string[]>([]);
  // 最後に適用した要求の seq。適用の直前に記録して StrictMode の effect 再実行を弾く
  const appliedRequestRef = useRef<number | null>(null);

  // ファイル参照からの要求は mount 後の effect で適用する (パネルは条件付き mount のため、
  // 「mount 時の token を無視する」reloadToken の方式では初回クリックを取り落とす)。
  // openFileTab は同一パスでも新しい state を返すので「タブが増えない」ことは 1 回適用の根拠にならない
  useEffect(() => {
    if (!openRequest || appliedRequestRef.current === openRequest.seq) return;
    appliedRequestRef.current = openRequest.seq;
    setTabs((prev) => openFileTab(prev, openRequest.path));
    onHandled?.(openRequest.seq);
  }, [openRequest, onHandled]);

  // 除外規則はサーバーが正。行の出し分けだけに使うため mount 時に 1 回取り、失敗しても導線は出す
  // (実際の拒否は download/check が行い、ツリーのエラー行に出る)
  useEffect(() => {
    if (readOnly) return;
    let cancelled = false;
    void (async () => {
      try {
        const health = await getHealth();
        if (!cancelled) setExcludeNames(health.archive?.excludeNames ?? []);
      } catch {
        // 取れないときは除外なしとして扱う (判定はサーバーに任せる)
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [readOnly]);

  // 未取得のディレクトリを表示順に取得する。状態遷移は lib/fileTree.ts の純関数だけが行う。
  useEffect(() => {
    const pending = pendingFileTreeDirectories(tree).filter((path) => !inFlightRef.current.has(path));
    if (pending.length === 0) return;
    for (const path of pending) inFlightRef.current.add(path);
    setTree((prev) => pending.reduce((acc, path) => beginFileTreeLoad(acc, path), prev));
    for (const path of pending) {
      void (async () => {
        try {
          const listing = await getFiles(fileTreeFetchPath(rootPath, path));
          setTree((prev) => applyFileTreeListing(prev, path, listing));
        } catch (error) {
          setTree((prev) => applyFileTreeError(prev, path, errorText(error)));
        } finally {
          inFlightRef.current.delete(path);
        }
      })();
    }
  }, [tree, rootPath]);

  // 外装の「再読み込み」とラン終了を 1 つの入口にする。mount 時の token では撃たない
  // (root の切替は key の張り替えで扱うため、token の初期値が残っていても取り直さない)
  const lastReloadTokenRef = useRef(reloadToken);
  useEffect(() => {
    if (lastReloadTokenRef.current === reloadToken) return;
    lastReloadTokenRef.current = reloadToken;
    setPreviewVersion((version) => version + 1);
    setTree((prev) => invalidateFileTree(prev));
  }, [reloadToken]);

  const toggle = (path: string) => {
    setTree((prev) => toggleFileTreeDirectory(prev, path));
  };

  const openTab = (path: string) => setTabs((prev) => openFileTab(prev, path));
  const closeTab = (path: string) => setTabs((prev) => closeFileTab(prev, path));

  /**
   * 削除は確認してからサーバーへ委譲する。ファイルは 1 件、ディレクトリは配下ごと消える。
   * 成功したら自分で消した行と、ディレクトリなら配下の state / タブを落とす (外部から消えた場合の現行挙動とは別)。
   * 失敗したら親ディレクトリのエラーとして出す (他の行は残す)。
   */
  const removeEntry = (path: string, type: "file" | "dir") => {
    if (deletingRef.current.has(path)) return;
    // 確認には画面の root 相対パスを出す (ツリーに見えているパスと合わせる)。ディレクトリは配下ごと消えることを示す
    const message = type === "dir" ? fileTreeDeleteDirectoryConfirm(path) : fileTreeDeleteConfirm(path);
    if (!window.confirm(message)) return;
    deletingRef.current.add(path);
    void (async () => {
      try {
        const fetchPath = fileTreeFetchPath(rootPath, path);
        if (type === "dir") {
          await deleteDirectory(fetchPath);
          setTabs((prev) => closeFileTabsUnder(prev, path));
          setTree((prev) => removeFileTreeEntry(pruneFileTreeSubtree(prev, path), path));
        } else {
          await deleteFile(fetchPath);
          closeTab(path);
          setTree((prev) => removeFileTreeEntry(prev, path));
        }
      } catch (error) {
        setTree((prev) => applyFileTreeError(prev, fileTreeParentPath(path), errorText(error)));
      } finally {
        deletingRef.current.delete(path);
      }
    })();
  };

  /**
   * リネームは設定ツリーだけの導線 (`canRename`)。現在の名前を初期値にした prompt で受け取り、成功したら
   * ツリーとタブ・表示モードの経路を新しい名前へ張り替える (開閉と取得済みの子は保ち、本文だけ取り直す)。
   * 失敗したら親ディレクトリのエラーとして出す (他の行は残す)。
   */
  const renameRow = (path: string, currentName: string) => {
    if (renamingRef.current.has(path)) return;
    const nextName = window.prompt(fileTreeRenamePrompt(path), currentName);
    // 取り消し (null)・空・未変更なら何もしない
    if (!nextName || nextName === currentName) return;
    renamingRef.current.add(path);
    void (async () => {
      try {
        await renameEntry(fileTreeFetchPath(rootPath, path), nextName);
        // 応答の root 相対パスは親の実パス基準 (symlink 経由の要求でツリーのキーとずれる) なので、
        // 画面の root 相対は親 + 新しい名前で組み立てる
        const nextPath = fileTreeChildPath(fileTreeParentPath(path), nextName);
        setTree((prev) => renameFileTreeEntry(prev, path, nextPath));
        setTabs((prev) => renameFileTabs(prev, path, nextPath));
        setPreviewModes((prev) => renamePreviewModes(prev, path, nextPath));
      } catch (error) {
        setTree((prev) => applyFileTreeError(prev, fileTreeParentPath(path), errorText(error)));
      } finally {
        renamingRef.current.delete(path);
      }
    })();
  };

  /**
   * ダウンロードは事前チェック (`download/check`) を通してから始める。除外 (`skipped`) があるときだけ確認を 1 回出し、
   * 開始は `<a download>` のプログラム的クリックにする (本文をメモリに保持せずページ遷移もしない)。
   * 除外名のディレクトリ・上限超過・通信失敗は削除と同じく親ディレクトリのエラー行に出し、行は残す。
   */
  const downloadRow = (path: string, name: string, type: "file" | "dir") => {
    if (downloadingRef.current.has(path)) return;
    downloadingRef.current.add(path);
    void (async () => {
      try {
        const fetchPath = fileTreeFetchPath(rootPath, path);
        const check = await getFileDownloadCheck(fetchPath);
        // サイズ / 件数の超過は check が 413 で返すので、確認より先にエラー行へ出る
        if (type === "dir" && check.skipped.length > 0 && !window.confirm(archiveConfirmMessage(name, check))) return;
        startArchiveDownload(fileDownloadUrl(fetchPath), check.name);
      } catch (error) {
        setTree((prev) => applyFileTreeError(prev, fileTreeParentPath(path), errorText(error)));
      } finally {
        downloadingRef.current.delete(path);
      }
    })();
  };

  // 閉じたタブ (上限で落ちた分も含む) の選択を捨てる。復元したタブが揃った状態で走る
  // (復元前の空の paths で消さないため、復元は lazy initializer 側で済ませてある)
  useEffect(() => {
    setPreviewModes((prev) => dropClosedPreviewModes(prev, tabs.paths));
  }, [tabs.paths]);

  // 変更のたびに保存する。他 root を消さない read-modify-write と、内容が同じときの書き込み省略は store 側
  useEffect(() => {
    filePreviewStore.write(rootPath, {
      paths: tabs.paths,
      active: tabs.active,
      modes: previewModes,
      dirs: openFileTreeDirectories(tree),
    });
  }, [rootPath, tree, tabs, previewModes]);

  const rootNode = fileTreeDirectoryState(tree, FILE_TREE_ROOT) ?? { open: true, loading: false };

  return (
    // 外装が渡す枠 (グリッドの 1 行 / flex の 1 要素) をそのまま埋める。内側の 1 段は @container でないと
    // 自分自身の幅を問い合わせられないため、判定はこの段で行う
    <div className="@container min-h-0">
      <div className="flex h-full min-h-0 flex-col @2xl:flex-row">
        {/* タブがあるときは shrink-0 を付けない。低い viewport でツリーが全高を取るとプレビュー本文が見えなくなるため、
            プレビューの min-h-40 へ譲る。タブが無いときはツリーを全幅に使う (空の列を作らない) */}
        <div
          className={cn(
            "min-h-0 scrollbar-thin overflow-x-hidden overflow-y-auto px-3 py-3",
            tabs.paths.length > 0 ? "max-h-64 @2xl:max-h-none @2xl:w-72 @2xl:flex-none" : "flex-1",
          )}
        >
          {rootNode.error ? (
            <MessageRow depth={0} danger alert>
              {rootNode.error}
            </MessageRow>
          ) : null}
          {rootNode.children ? (
            <Branch
              parent={FILE_TREE_ROOT}
              node={rootNode}
              depth={0}
              tree={tree}
              selected={tabs.active}
              canRename={canRename}
              readOnly={readOnly}
              excludeNames={excludeNames}
              onToggle={toggle}
              onSelect={openTab}
              onRename={renameRow}
              onDelete={removeEntry}
              onDownload={downloadRow}
            />
          ) : rootNode.error ? null : (
            <MessageRow depth={0}>読み込み中…</MessageRow>
          )}
        </div>
        {tabs.paths.length > 0 && tabs.active ? (
          <FilePreview
            key={previewVersion}
            paths={tabs.paths}
            activePath={tabs.active}
            rootPath={rootPath}
            modes={previewModes}
            onModeChange={(path: string, mode: PreviewMode) =>
              setPreviewModes((prev) => withPreviewMode(prev, path, mode))
            }
            onSelect={openTab}
            onClose={closeTab}
          />
        ) : null}
      </div>
    </div>
  );
}

type BranchProps = {
  parent: string;
  node: FileTreeDirectoryState;
  depth: number;
  tree: FileTreeState;
  selected: string | null;
  canRename: boolean;
  readOnly: boolean;
  /** ワークスペースの除外名 (行のダウンロードを出すかの判定に使う) */
  excludeNames: readonly string[];
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
  onRename: (path: string, name: string) => void;
  onDelete: (path: string, type: "file" | "dir") => void;
  onDownload: (path: string, name: string, type: "file" | "dir") => void;
};

function Branch({
  parent,
  node,
  depth,
  tree,
  selected,
  canRename,
  readOnly,
  excludeNames,
  onToggle,
  onSelect,
  onRename,
  onDelete,
  onDownload,
}: BranchProps) {
  const entries = node.children ?? [];
  return (
    // 明示的な minmax(0,1fr) で行幅を容器に固定する (auto だと長い名前の max-content まで広がり、省略記号ではなく overflow で切れる)
    <div className="grid min-w-0 grid-cols-1 gap-0.5">
      {entries.length === 0 ? <MessageRow depth={depth}>（空）</MessageRow> : null}
      {entries.map((entry) => (
        <EntryRow
          key={entry.name}
          parent={parent}
          entry={entry}
          depth={depth}
          tree={tree}
          selected={selected}
          canRename={canRename}
          readOnly={readOnly}
          excludeNames={excludeNames}
          onToggle={onToggle}
          onSelect={onSelect}
          onRename={onRename}
          onDelete={onDelete}
          onDownload={onDownload}
        />
      ))}
      {node.truncated ? <MessageRow depth={depth}>上限のため {entries.length} 件のみ表示しています</MessageRow> : null}
    </div>
  );
}

function EntryRow({
  parent,
  entry,
  depth,
  tree,
  selected,
  canRename,
  readOnly,
  excludeNames,
  onToggle,
  onSelect,
  onRename,
  onDelete,
  onDownload,
}: {
  parent: string;
  entry: FileEntry;
  depth: number;
  tree: FileTreeState;
  selected: string | null;
  canRename: boolean;
  readOnly: boolean;
  excludeNames: readonly string[];
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
  onRename: (path: string, name: string) => void;
  onDelete: (path: string, type: "file" | "dir") => void;
  onDownload: (path: string, name: string, type: "file" | "dir") => void;
}) {
  const path = fileTreeChildPath(parent, entry.name);

  if (entry.type === "dir") {
    const node = fileTreeDirectoryState(tree, path);
    const open = node?.open ?? false;
    return (
      <div>
        {/* 行全体を button にすると時刻が accessible name に混ざり、時刻のクリックでも開閉するため、
            ファイル行と同じ「div + flex-1 の操作 button」に分ける */}
        <div
          style={{ "--tree-indent": `${depth * INDENT + 8}px` } as CSSProperties}
          className="flex min-h-7.5 w-full items-center rounded-lg pr-1 pl-(--tree-indent) text-xs text-ink transition-colors hover:bg-hover"
        >
          <button
            type="button"
            aria-expanded={open}
            onClick={() => onToggle(path)}
            className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left"
          >
            <span
              className={cn(
                "grid size-4 shrink-0 place-items-center text-ink-faint transition-transform",
                open ? "rotate-90" : "",
              )}
            >
              <ChevronIcon />
            </span>
            <FolderIcon open={open} />
            <span className="min-w-0 truncate">{entry.name}</span>
            {entry.symlink ? <SymlinkMark /> : null}
          </button>
          <EntryTime at={entry.mtime} />
          <EntryRowActions
            name={entry.name}
            type={entry.type}
            symlink={entry.symlink}
            canRename={canRename}
            readOnly={readOnly}
            excludeNames={excludeNames}
            onRename={() => onRename(path, entry.name)}
            onDelete={() => onDelete(path, entry.type)}
            onDownload={() => onDownload(path, entry.name, entry.type)}
          />
        </div>
        {open ? (
          <>
            {node?.error ? (
              <MessageRow depth={depth + 1} danger alert>
                {node.error}
              </MessageRow>
            ) : null}
            {node?.children ? (
              <Branch
                parent={path}
                node={node}
                depth={depth + 1}
                tree={tree}
                selected={selected}
                canRename={canRename}
                readOnly={readOnly}
                excludeNames={excludeNames}
                onToggle={onToggle}
                onSelect={onSelect}
                onRename={onRename}
                onDelete={onDelete}
                onDownload={onDownload}
              />
            ) : node?.error ? null : (
              <MessageRow depth={depth + 1}>読み込み中…</MessageRow>
            )}
          </>
        ) : null}
      </div>
    );
  }

  const isSelected = selected === path;
  return (
    // 行全体は選択、右端のスロットはリネーム (フォルダのみ) と削除。入れ子の button は作れないため、行は div にして button を並べる
    <div
      style={{ "--tree-indent": `${depth * INDENT + FILE_INDENT}px` } as CSSProperties}
      className={cn(
        "flex min-h-7.5 w-full items-center rounded-lg pr-1 pl-(--tree-indent) text-xs transition-colors",
        isSelected ? "bg-accent-wash text-accent-text" : "text-ink-soft hover:bg-hover hover:text-ink",
      )}
    >
      <button
        type="button"
        aria-current={isSelected ? "true" : undefined}
        onClick={() => onSelect(path)}
        className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left"
      >
        <FileIcon kind={fileKind(entry.name)} />
        <span className="min-w-0 truncate">{entry.name}</span>
        {entry.symlink ? <SymlinkMark /> : null}
      </button>
      <EntryTime at={entry.mtime} />
      <EntryRowActions
        name={entry.name}
        type={entry.type}
        symlink={entry.symlink}
        canRename={canRename}
        readOnly={readOnly}
        excludeNames={excludeNames}
        onRename={() => onRename(path, entry.name)}
        onDelete={() => onDelete(path, entry.type)}
        onDownload={() => onDownload(path, entry.name, entry.type)}
      />
    </div>
  );
}

/**
 * 行の右端。時刻の右に ダウンロード → リネーム (設定ツリーのみ) → 削除 の順で size-6 のスロットを並べる。
 * 導線を持たない行 (除外名 / symlink) もスロットだけ空けて時刻の右端をそろえる。
 * 行の外に置くのは、行 (EntryRow) が組み立てたパスを渡すためと、描画のテストで直接見るため。
 */
export function EntryRowActions({
  name,
  type,
  symlink,
  canRename,
  readOnly,
  excludeNames,
  onRename,
  onDelete,
  onDownload,
}: {
  name: string;
  type: "file" | "dir";
  symlink?: boolean;
  canRename: boolean;
  readOnly: boolean;
  /** ワークスペースの除外名 (health の `archive.excludeNames`)。除外名の行にはダウンロードを出さない */
  excludeNames: readonly string[];
  onRename: () => void;
  onDelete: () => void;
  onDownload: () => void;
}) {
  // リネームはフォルダ行だけに出す (UI からファイルは改名できない)。symlink はサンドボックスが 400 で拒否する
  const renamable = canRename && type === "dir" && !symlink;
  const deletable = !symlink;
  // ダウンロードは通常ファイルとディレクトリに出す。symlink は api が 400 で拒否し、除外名の行は zip に入らない
  const downloadable = !symlink && !isArchiveExcludedName(name, excludeNames);
  // 読み取り専用の面 (スキルのファイルタブ) は削除 / リネーム / ダウンロードの導線ごと消す
  if (readOnly) return null;
  return (
    <>
      {downloadable ? <DownloadRowButton name={name} type={type} onClick={onDownload} /> : <EmptySlot />}
      {canRename ? renamable ? <RenameRowButton name={name} onClick={onRename} /> : <EmptySlot /> : null}
      {deletable ? <DeleteRowButton name={name} onClick={onDelete} /> : <EmptySlot />}
    </>
  );
}

/** 行のダウンロードボタン。ディレクトリは ZIP になり、除外があることをツールチップで開示する。 */
function DownloadRowButton({ name, type, onClick }: { name: string; type: "file" | "dir"; onClick: () => void }) {
  const directory = type === "dir";
  return (
    <button
      type="button"
      aria-label={directory ? `${name} を ZIP でダウンロード` : `${name} をダウンロード`}
      title={directory ? "ZIP でダウンロード（ビルド成果物と依存を除く）" : "ダウンロード"}
      onClick={onClick}
      className="grid size-6 shrink-0 place-items-center rounded-md text-ink-faint transition-colors hover:bg-raised hover:text-ink"
    >
      <DownloadIcon />
    </button>
  );
}

/** 行のリネームボタン。削除ボタンと同じ寸法・色で、その左に並べる。 */
function RenameRowButton({ name, onClick }: { name: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={`${name} の名前を変更`}
      title="名前を変更"
      onClick={onClick}
      className="grid size-6 shrink-0 place-items-center rounded-md text-ink-faint transition-colors hover:bg-raised hover:text-ink"
    >
      <PencilIcon />
    </button>
  );
}

/** 行の削除ボタン。ディレクトリ行とファイル行で同じ見た目にし、末尾スロットを size-6 にそろえる。 */
function DeleteRowButton({ name, onClick }: { name: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={`${name} を削除`}
      title="削除"
      onClick={onClick}
      className="grid size-6 shrink-0 place-items-center rounded-md text-ink-faint transition-colors hover:bg-raised hover:text-danger-text"
    >
      <TrashIcon />
    </button>
  );
}

/** 導線を持たない行 (ファイルのリネーム / symlink) の末尾スロット。時刻の右端をボタンの行にそろえる。 */
function EmptySlot() {
  return <span aria-hidden className="size-6 shrink-0" />;
}

/** 行の更新時刻。stat できなかった行 (壊れた symlink) には出さない。 */
function EntryTime({ at }: { at: number | undefined }) {
  if (at === undefined) return null;
  return (
    <time
      dateTime={new Date(at).toISOString()}
      title={messageFullTimeLabel(at)}
      className="shrink-0 text-2xs whitespace-nowrap text-ink-ghost tabular-nums"
    >
      {messageTimeLabel(at)}
    </time>
  );
}

function MessageRow({
  depth,
  children,
  danger = false,
  alert = false,
}: {
  depth: number;
  children: ReactNode;
  danger?: boolean;
  alert?: boolean;
}) {
  return (
    <div
      role={alert ? "alert" : undefined}
      style={{ "--tree-indent": `${depth * INDENT + FILE_INDENT}px` } as CSSProperties}
      className={cn(
        "py-1.5 pr-2 pl-(--tree-indent) text-1xs leading-relaxed break-words",
        danger ? "text-danger-text" : "text-ink-muted",
      )}
    >
      {children}
    </div>
  );
}

/** root 外を指す symlink は開くと 400 になるため、一覧の時点で印を付ける */
function SymlinkMark() {
  return <span className="shrink-0 rounded border border-line px-1 text-3xs leading-4 text-ink-ghost">リンク</span>;
}
