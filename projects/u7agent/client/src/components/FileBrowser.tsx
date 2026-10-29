import { useCallback, useEffect, useRef, useState, type CSSProperties, type RefObject, type ReactNode } from "react";
import { deleteDirectory, deleteFile, fileDownloadUrl, getFileDownloadCheck, getFiles, renameEntry } from "../api";
import { useFileTreeHeight } from "../hooks/useFileTreeHeight";
import { useFileTreeWidth } from "../hooks/useFileTreeWidth";
import { useImageVersion } from "../hooks/useImageVersion";
import { useMessageCopy } from "../hooks/useMessageCopy";
import { FileTreeHeightResizeHandle } from "./file-tree/FileTreeHeightResizeHandle";
import { FileTreeWidthResizeHandle } from "./file-tree/FileTreeWidthResizeHandle";
import { FilePreview } from "./FilePreview";
import { useConfirm, usePrompt } from "./ConfirmProvider";
import { cn } from "../lib/cn";
import { renameInputValue } from "../lib/confirmDialog";
import { archiveConfirmRequest, startArchiveDownload } from "../lib/archive";
import { formatBytes } from "../lib/attachments";
import {
  applyFileTreeError,
  applyFileTreeListing,
  beginFileTreeLoad,
  createFileTreeStateFromDirectories,
  FILE_TREE_ROOT,
  fileTreeAbsolutePath,
  fileTreeChildPath,
  fileTreeDeleteConfirmRequest,
  fileTreeDirectoryState,
  fileTreeEntryFor,
  fileTreeFetchPath,
  fileTreeParentPath,
  fileTreeRenameRequest,
  invalidateFileTree,
  isHiddenFileTreePath,
  normalizeFileTreeRoot,
  openFileTreeAncestors,
  openFileTreeDirectories,
  pendingFileTreeDirectories,
  pruneFileTreeSubtree,
  removeFileTreeEntry,
  renameFileTreeEntry,
  toggleFileTreeDirectory,
  visibleFileTreeDirectories,
  visibleFileTreeEntries,
  type FileTreeDirectoryState,
  type FileTreeState,
} from "../lib/fileTree";
import { requestFileTreeReload, settleFileTreeRequest, type FileTreeReloadGate } from "../lib/fileTreeReload";
import { fileKind } from "../lib/fileKind";
import { FILE_TREE_STACK_BREAKPOINT } from "../lib/fileTreeWidth";
import { FILE_MENTION_MIME, mentionText } from "../lib/fileMention";
import { fileRowActions, fileRowShareTarget, type FileRowActionKind } from "../lib/fileRowMenu";
import { filePreviewStore } from "../lib/filePreviewState";
import { fileTimeLabel, messageFullTimeLabel } from "../lib/messageTime";
import {
  closeFileTab,
  closeFileTabsUnder,
  dropClosedPreviewModes,
  dropClosedPreviewOrigins,
  openFileTab,
  renameFileTabs,
  renamePreviewModes,
  renamePreviewOrigins,
  restoreFileTabsState,
  withPreviewMode,
  withPreviewOrigin,
  type FileTabsState,
  type PreviewMode,
  type PreviewModes,
  type PreviewOrigin,
  type PreviewOrigins,
} from "../lib/fileTabs";
import type { FileEntry } from "../types";
import { ChevronIcon, FileIcon, FolderIcon } from "./icons";
import { PathCopyFailure } from "./file-tree/PathCopyFailure";
import { LoadingMark } from "./LoadingMark";
import { RowMenu } from "./RowMenu";

const INDENT = 16;
/** ファイル行の左端。親の chevron (16) + gap-2 (8) + ディレクトリ行の左端 (8) と一致させる */
const FILE_INDENT = 32;
/** 隠す名前の既定。既定値の `[]` を render ごとに作り直すと、一覧の取得 Effect の依存が毎回変わってしまう */
const NO_HIDDEN_NAMES: readonly string[] = [];
/** reveal の一時ハイライトを残す時間。行が見つかってスクロールしてから数える */
const REVEAL_HIGHLIGHT_MS = 1600;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type FileBrowserProps = {
  /** ワークスペース root 相対 ("" や絶対パスは root へ畳まれる) */
  root: string;
  /** ワークスペース root の絶対パス (health.cwd)。絶対パスをコピーする導線に使う (未取得の "" では出さない) */
  rootCwd?: string;
  /** 値を変えると一覧と開いている本文を取り直す。mount 時の値では撃たない */
  reloadToken: number;
  /** フォルダ行の ⋯ メニューにリネームを出すか。既定 false (チャット右パネルでは出さない) */
  canRename?: boolean;
  /** 行の ⋯ から実体を移す / 変える操作 (共有 / ダウンロード / リネーム / 削除) を出さない。パスのコピーは残す。既定 false */
  readOnly?: boolean;
  /** ファイル行を参照としてドラッグできるようにする。ドロップ先 (入力欄) と同じ root の面だけ true */
  canRef?: boolean;
  /**
   * 行ごと隠す名前 (名前一致・階層を問わない)。作業環境パネルだけが `.git` を渡す
   * (設定 → ファイル とスキルのファイルタブは渡さず、全部見える。docs/file-preview.md)。
   * 取得済みの一覧には効かないため、mount の間で変えない (root と同じ前提)。
   */
  hiddenNames?: readonly string[];
  /**
   * アーカイブの除外名の実効値 (設定ストア)。除外名の行にはダウンロードを出さない。
   * 取得元を health ではなく app 状態 (prop) にすることで、設定の保存直後に再 mount なしで追随する。
   */
  excludeNames: readonly string[];
  /** 未消費の「ファイル参照から開く」要求。適用したら onHandled(seq) で呼び出し元へ返す */
  openRequest?: { seq: number; path: string } | null;
  onHandled?: (seq: number) => void;
  /**
   * 行の ⋯ の「共有」(Cloudflare への静的公開) から呼ぶ。渡した面にだけ項目を出す。
   * path は面の root 相対で、作業フォルダ面では共有 API の `directory` と同じ基準になる
   * (ワークスペース root を指す設定 → ファイル には渡さない)
   */
  onShareDirectory?: (path: string) => void;
  /**
   * root 直下の `index.html` 行から作業フォルダ自身 (この面の root) を共有できるか。
   * 非プロジェクト会話の作業フォルダ面だけ true (プロジェクト会話はサーバーが 409 で拒否する)
   */
  canShareSessionRoot?: boolean;
  /**
   * 「共有」を押せない理由 (会話の実行中など)。渡すと行メニューの共有項目を無効にし、理由を出す
   */
  shareBlockedReason?: string;
  /** プレビュー オリジン (別オリジン) のブラウザから見たポート。health から受け取り、未取得は undefined */
  filePreviewPort?: number;
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
  rootCwd = "",
  reloadToken,
  canRename = false,
  readOnly = false,
  canRef = false,
  hiddenNames = NO_HIDDEN_NAMES,
  excludeNames,
  openRequest,
  onHandled,
  onShareDirectory,
  canShareSessionRoot = false,
  shareBlockedReason,
  filePreviewPort,
}: FileBrowserProps) {
  const rootPath = normalizeFileTreeRoot(root);
  // 行の絶対パスを組み立てる 1 箇所。行は画面の root を知らないので、描画側から渡す
  const absolutePathOf = (path: string) => fileTreeAbsolutePath(rootCwd, rootPath, path);
  const confirm = useConfirm();
  const prompt = usePrompt();
  // 復元は mount ごとに 1 回。lazy initializer に置くことで、復元前の空状態を取得や保存の Effect が見ない
  // (StrictMode で初期化が 2 回走っても同じ snapshot から同じ状態になる)
  const [restored] = useState(() => filePreviewStore.read(rootPath));
  // 隠す枝は復元の時点で落とす (行が出ないまま保存値へ残り続けるのを避ける)
  const [tree, setTree] = useState<FileTreeState>(() =>
    createFileTreeStateFromDirectories(visibleFileTreeDirectories(restored?.dirs ?? [], hiddenNames)),
  );
  const [tabs, setTabs] = useState<FileTabsState>(() =>
    restoreFileTabsState(restored?.paths ?? [], restored?.active ?? null),
  );
  // 一覧の再読み込みでプレビュー本文も捨てる (開いているタブは保つ)
  const previewVersion = useImageVersion(reloadToken);
  // 表示モードは再読み込みの remount を跨ぐ必要がある (選択はタブを閉じるまで保持する) ため親が持つ (docs/file-preview.md)
  const [previewModes, setPreviewModes] = useState<PreviewModes>(() => restored?.modes ?? {});
  // ストレージ有効モードの選択は保存しない (F5 とタブを閉じるで既定の ON に戻すため、snapshot に載せず mount ごとに空から始める)
  const [previewOrigins, setPreviewOrigins] = useState<PreviewOrigins>({});
  // 幅は左右 2 段のときだけ効く。ツリーの親 (@container) 自身を測り、--file-tree-width をそこへ入れる
  const treeWidth = useFileTreeWidth();
  // 高さは上下 2 段のときだけ効く (左右 2 段では容器に従う)。同じコンテナの高さを bounds の根拠にする
  const treeHeight = useFileTreeHeight({
    containerRef: treeWidth.containerRef,
    containerHeight: treeWidth.containerHeight,
  });
  // 上下 2 段かどうかは css の `@2xl` と同じ幅で決める (高さの選択はこの面だけ)
  const stacked = treeWidth.containerWidth < FILE_TREE_STACK_BREAKPOINT;
  // タブが 1 枚も無いときはプレビュー列を作らない (高さも選ばない)
  const hasTabs = tabs.paths.length > 0;
  // StrictMode の effect 二重実行と、取得中の再読み込みで同じディレクトリを二重に要求しない
  const inFlightRef = useRef<Set<string>>(new Set());
  // 取得中に来た再読み込みの要求。最後の取得が決着してから 1 回だけ反映する
  const reloadGateRef = useRef<FileTreeReloadGate>({ pending: false });
  // 同じ行の削除を二重に送らない (実体が消えた後の再要求で 404 を出さないため)
  const deletingRef = useRef<Set<string>>(new Set());
  // 同じ行のリネームを二重に送らない (削除と同じ理由)
  const renamingRef = useRef<Set<string>>(new Set());
  // 同じ行のダウンロードを二重に始めない (確認ダイアログが二重に出ないように)
  const downloadingRef = useRef<Set<string>>(new Set());
  // 最後に適用した要求の seq。適用の直前に記録して StrictMode の effect 再実行を弾く
  const appliedRequestRef = useRef<number | null>(null);

  // ツリーで対象の位置を示す要求 (reveal)。ファイル参照から開いた時と、プレビューのパンくずから受ける。
  // 祖先を開くのは state の遷移、スクロールと一時ハイライトは描画後 (対象の行は取得が終わるまで無い)
  const [reveal, setReveal] = useState<{ path: string; seq: number } | null>(null);
  const revealSeqRef = useRef(0);
  // スクロール済みの seq。tree の更新ごとの再実行で同じ対象を何度もスクロールしない
  const revealedSeqRef = useRef<number | null>(null);
  // 対象の行だけがこの ref を持つ (一致する行の設置時にスクロールする)
  const revealRowRef = useRef<HTMLDivElement | null>(null);
  const revealTimerRef = useRef<number | null>(null);

  const revealRow = useCallback(
    (path: string) => {
      // 隠した枝は行が無い。祖先を開くと不可視の展開が state と保存値に残るので、reveal ごと持たない
      if (isHiddenFileTreePath(path, hiddenNames)) return;
      // 祖先を開いてから対象を指す。取得は既存の pendingFileTreeDirectories の経路が親から順に拾う
      setTree((prev) => openFileTreeAncestors(prev, path));
      revealSeqRef.current += 1;
      setReveal({ path, seq: revealSeqRef.current });
    },
    [hiddenNames],
  );

  // 対象の行が現れたらスクロールして一時ハイライトする。祖先の取得中は行が無いので、
  // tree が進むたびに再実行して取りこぼさない。ハイライトはスクロール後だけ残す
  useEffect(() => {
    if (reveal === null || revealedSeqRef.current === reveal.seq) return;
    const row = revealRowRef.current;
    if (row === null) return;
    revealedSeqRef.current = reveal.seq;
    row.scrollIntoView({ block: "nearest", inline: "nearest" });
    if (revealTimerRef.current !== null) window.clearTimeout(revealTimerRef.current);
    revealTimerRef.current = window.setTimeout(() => {
      revealTimerRef.current = null;
      setReveal((current) => (current?.seq === reveal.seq ? null : current));
    }, REVEAL_HIGHLIGHT_MS);
  }, [reveal, tree]);

  // 折りたたみの高さの遷移の途中は行の位置が確定しないため、遷移が終わってからスクロールを合わせ直す
  // (block: "nearest" はその時点の位置で決まる)。合図は transitionend だけにする: 遷移が走った枝にだけ
  // listener が付くので、祖先が既に開いているとき (遷移なし) は何も起きず、直後の手動スクロールを
  // 巻き戻さない。reduced motion でも遷移が無く、最初のスクロールがそのまま正しい。
  // tree に依存させるのは、祖先の一覧の取得で行が現れるのがこの effect のあとになるため
  useEffect(() => {
    if (reveal === null) return;
    const row = revealRowRef.current;
    if (row === null) return;
    const folds: HTMLElement[] = [];
    for (let el = row.parentElement; el !== null; el = el.parentElement) {
      if (el.classList.contains("tree-fold")) folds.push(el);
    }
    const scrollToRow = (event: TransitionEvent) => {
      // 子孫の折りたたみの遷移も泡で届く (兄弟の枝を開くと祖先の listener が鳴る) ため、
      // その入れ物自身の高さの遷移だけを見る。色や chevron の遷移は propertyName で落とす
      if (event.target !== event.currentTarget) return;
      if (event.propertyName !== "grid-template-rows") return;
      row.scrollIntoView({ block: "nearest", inline: "nearest" });
    };
    for (const fold of folds) fold.addEventListener("transitionend", scrollToRow);
    return () => {
      for (const fold of folds) fold.removeEventListener("transitionend", scrollToRow);
    };
  }, [reveal, tree]);

  // unmount 後にタイマーを残さない (幅やレイアウトの切替で FileBrowser ごと入れ替わる面がある)
  useEffect(
    () => () => {
      if (revealTimerRef.current !== null) window.clearTimeout(revealTimerRef.current);
    },
    [],
  );

  // ファイル参照からの要求は mount 後の effect で適用する (パネルは条件付き mount のため、
  // 「mount 時の token を無視する」reloadToken の方式では初回クリックを取り落とす)。
  // openFileTab は同一パスでも新しい state を返すので「タブが増えない」ことは 1 回適用の根拠にならない
  useEffect(() => {
    if (!openRequest || appliedRequestRef.current === openRequest.seq) return;
    appliedRequestRef.current = openRequest.seq;
    setTabs((prev) => openFileTab(prev, openRequest.path));
    // 参照されたファイルはツリーでも位置を示す (祖先を開いてスクロール + 一時ハイライト)
    revealRow(openRequest.path);
    onHandled?.(openRequest.seq);
  }, [openRequest, onHandled, revealRow]);

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
          setTree((prev) =>
            applyFileTreeListing(prev, path, {
              entries: visibleFileTreeEntries(listing.entries, hiddenNames),
              truncated: listing.truncated,
            }),
          );
        } catch (error) {
          setTree((prev) => applyFileTreeError(prev, path, errorText(error)));
        } finally {
          inFlightRef.current.delete(path);
          const reload = settleFileTreeRequest(reloadGateRef.current, inFlightRef.current.size);
          reloadGateRef.current = reload.gate;
          if (reload.applyNow) setTree((prev) => invalidateFileTree(prev));
        }
      })();
    }
  }, [tree, rootPath, hiddenNames]);

  // 外装の「再読み込み」とラン終了を 1 つの入口にする。mount 時の token では撃たない
  // (root の切替は key の張り替えで扱うため、token の初期値が残っていても取り直さない)
  const lastReloadTokenRef = useRef(reloadToken);
  useEffect(() => {
    if (lastReloadTokenRef.current === reloadToken) return;
    lastReloadTokenRef.current = reloadToken;
    // 取得中に invalidate すると、後着の古い応答が loading を解除して取り直しが失われる。
    // 取得が無いときだけ即時、あるときは最後の取得の finally へ譲る
    const reload = requestFileTreeReload(reloadGateRef.current, inFlightRef.current.size);
    reloadGateRef.current = reload.gate;
    if (reload.applyNow) setTree((prev) => invalidateFileTree(prev));
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
    deletingRef.current.add(path);
    void (async () => {
      try {
        // 確認には画面の root 相対パスを出す (ツリーに見えているパスと合わせる)。ディレクトリは配下ごと消えることを示す
        if (!(await confirm(fileTreeDeleteConfirmRequest(path, type)))) return;
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
   * リネームは設定ツリーだけの導線 (`canRename`)。現在の名前を初期値にした入力で受け取り、成功したら
   * ツリーとタブ・表示モードの経路を新しい名前へ張り替える (開閉と取得済みの子は保ち、本文だけ取り直す)。
   * 失敗したら親ディレクトリのエラーとして出す (他の行は残す)。
   */
  const renameRow = (path: string, currentName: string) => {
    if (renamingRef.current.has(path)) return;
    renamingRef.current.add(path);
    void (async () => {
      try {
        const nextName = renameInputValue(await prompt(fileTreeRenameRequest(path, currentName)), currentName);
        // 取り消し・空・未変更なら何もしない
        if (nextName === undefined) return;
        await renameEntry(fileTreeFetchPath(rootPath, path), nextName);
        // 応答の root 相対パスは親の実パス基準 (symlink 経由の要求でツリーのキーとずれる) なので、
        // 画面の root 相対は親 + 新しい名前で組み立てる
        const nextPath = fileTreeChildPath(fileTreeParentPath(path), nextName);
        setTree((prev) => renameFileTreeEntry(prev, path, nextPath));
        setTabs((prev) => renameFileTabs(prev, path, nextPath));
        setPreviewModes((prev) => renamePreviewModes(prev, path, nextPath));
        setPreviewOrigins((prev) => renamePreviewOrigins(prev, path, nextPath));
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
        if (type === "dir" && check.skipped.length > 0 && !(await confirm(archiveConfirmRequest(name, check)))) return;
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
    setPreviewOrigins((prev) => dropClosedPreviewOrigins(prev, tabs.paths));
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

  // 表示中のタブのサイズは取得済みの行から引く (メタ表示のために一覧を取り直さない)。未取得は undefined
  const activeSize = tabs.active === null ? undefined : fileTreeEntryFor(tree, tabs.active)?.size;
  const rootNode = fileTreeDirectoryState(tree, FILE_TREE_ROOT) ?? { open: true, loading: false };

  return (
    // 外装が渡す枠 (グリッドの 1 行 / flex の 1 要素) をそのまま埋める。内側の 1 段は @container でないと
    // 自分自身の幅を問い合わせられないため、判定はこの段で行う
    <div
      ref={treeWidth.containerRef}
      className="@container min-h-0"
      style={
        {
          "--file-tree-width": `${treeWidth.width}px`,
          // 未指定は変数を消し、CSS の既定 (内容の高さ + 上限) に任せる。0px はツリーを完全に隠す
          "--file-tree-height": treeHeight.height === null ? undefined : `${treeHeight.height}px`,
          // 未指定のときだけ効く上限 (選んだ高さのときは --file-tree-height が上限を兼ねる)
          "--file-tree-height-max": `${treeHeight.limit}px`,
        } as CSSProperties
      }
    >
      <div className="relative flex h-full min-h-0 flex-col @2xl:flex-row">
        {/* タブがあるときは shrink-0 を付けない。低い viewport でツリーが全高を取るとプレビュー本文が見えなくなるため、
            プレビューの min-h-40 へ譲る。タブが無いときはツリーを全幅に使う (空の列を作らない)。
            左右 2 段では幅を --file-tree-width で選べる (既定はコンテナの 1/3。lib/fileTreeWidth.ts)、
            上下 2 段では高さを --file-tree-height で選べる (既定は内容の高さ。lib/fileTreeHeight.ts) */}
        <div
          className={cn(
            "relative min-h-0",
            // タブが無いときはプレビュー列が無いので、ツリーを全高に使う
            !hasTabs && "flex-1",
            hasTabs && !stacked && "@2xl:w-(--file-tree-width) @2xl:flex-none",
          )}
        >
          <div
            className={cn(
              "scrollbar-stable min-h-0 w-full scrollbar-thin overflow-x-hidden overflow-y-auto",
              // 選べるのは上下 2 段でタブがあるときだけ。左右 2 段とタブ無しは容器の高さに従う
              hasTabs && stacked ? "file-tree-height" : "h-full",
            )}
            // 高さ 0 はツリーを完全に隠す。見えない行を Tab と読み上げの対象に残さない (.tree-fold と同じ)
            inert={hasTabs && stacked && treeHeight.height === 0}
          >
            {/* 余白は内容側が持つ: スクロール枠が高さを選ぶ面なので、枠自身の padding は
                border-box の高さを押し広げる (0〜24px の指定が効かなくなる) */}
            <div className="px-4 py-3">
              {rootNode.error ? (
                <MessageRow depth={0} danger alert>
                  {rootNode.error}
                </MessageRow>
              ) : null}
              {rootNode.children ? (
                <Branch
                  parent={FILE_TREE_ROOT}
                  absolutePathOf={absolutePathOf}
                  node={rootNode}
                  depth={0}
                  tree={tree}
                  selected={tabs.active}
                  canRename={canRename}
                  readOnly={readOnly}
                  canRef={canRef}
                  excludeNames={excludeNames}
                  onShare={onShareDirectory}
                  canShareSessionRoot={canShareSessionRoot}
                  shareBlockedReason={shareBlockedReason}
                  onToggle={toggle}
                  onSelect={openTab}
                  onRename={renameRow}
                  onDelete={removeEntry}
                  onDownload={downloadRow}
                  revealPath={reveal?.path ?? null}
                  revealRef={revealRowRef}
                />
              ) : rootNode.error ? null : (
                <MessageRow depth={0}>
                  <LoadingMark />
                </MessageRow>
              )}
            </div>
          </div>
          {/* 高さのハンドルもスクロール枠の兄弟に置く (中に置くと absolute でも内容と一緒にスクロールする)。
              プレビュー側へはみ出さないよう、境界の上 (ツリーの中) に重ねる */}
          {hasTabs && stacked && treeHeight.resizable ? (
            <FileTreeHeightResizeHandle
              height={treeHeight.height}
              min={treeHeight.min}
              max={treeHeight.max}
              preview={treeHeight.preview}
              commit={treeHeight.commit}
              reset={treeHeight.reset}
            />
          ) : null}
        </div>
        {/* 幅のハンドルはスクロール枠の兄弟に置く (中に置くと absolute でも内容と一緒にスクロールする)。
            位置はツリーの右端 = 境界の中心で、--file-tree-width に追随する */}
        {hasTabs && treeWidth.resizable ? (
          <FileTreeWidthResizeHandle
            width={treeWidth.width}
            min={treeWidth.min}
            max={treeWidth.max}
            preview={treeWidth.preview}
            commit={treeWidth.commit}
            reset={treeWidth.reset}
          />
        ) : null}
        {tabs.paths.length > 0 && tabs.active ? (
          <FilePreview
            key={previewVersion}
            previewVersion={previewVersion}
            paths={tabs.paths}
            activePath={tabs.active}
            rootPath={rootPath}
            modes={previewModes}
            origins={previewOrigins}
            filePreviewPort={filePreviewPort}
            activeSize={activeSize}
            onModeChange={(path: string, mode: PreviewMode) =>
              setPreviewModes((prev) => withPreviewMode(prev, path, mode))
            }
            onOriginChange={(path: string, origin: PreviewOrigin) =>
              setPreviewOrigins((prev) => withPreviewOrigin(prev, path, origin))
            }
            onSelect={openTab}
            onClose={closeTab}
            onReveal={revealRow}
          />
        ) : null}
      </div>
    </div>
  );
}

type BranchProps = {
  parent: string;
  /** 画面 root 相対パスをワークスペースの絶対パスへ写す (health 未取得は undefined) */
  absolutePathOf: (path: string) => string | undefined;
  node: FileTreeDirectoryState;
  depth: number;
  tree: FileTreeState;
  selected: string | null;
  canRename: boolean;
  readOnly: boolean;
  canRef: boolean;
  /** ワークスペースの除外名 (行のダウンロードを出すかの判定に使う) */
  excludeNames: readonly string[];
  /** 「共有」を出せる面のときだけ渡す (未指定は項目を出さない) */
  onShare?: (path: string) => void;
  /** root 直下の `index.html` 行に「このフォルダを共有」を出すか */
  canShareSessionRoot: boolean;
  /** 「共有」を押せない理由 (実行中など)。undefined なら押せる */
  shareBlockedReason?: string;
  /** reveal 対象のパス。一致する行だけ ref を付け、スクロールと一時ハイライトの対象にする */
  revealPath: string | null;
  revealRef: RefObject<HTMLDivElement | null>;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
  onRename: (path: string, name: string) => void;
  onDelete: (path: string, type: "file" | "dir") => void;
  onDownload: (path: string, name: string, type: "file" | "dir") => void;
};

function Branch({
  parent,
  absolutePathOf,
  node,
  depth,
  tree,
  selected,
  canRename,
  readOnly,
  canRef,
  excludeNames,
  onShare,
  canShareSessionRoot,
  shareBlockedReason,
  revealPath,
  revealRef,
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
          absolutePathOf={absolutePathOf}
          entry={entry}
          depth={depth}
          tree={tree}
          selected={selected}
          canRename={canRename}
          readOnly={readOnly}
          canRef={canRef}
          excludeNames={excludeNames}
          onShare={onShare}
          canShareSessionRoot={canShareSessionRoot}
          shareBlockedReason={shareBlockedReason}
          revealPath={revealPath}
          revealRef={revealRef}
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

/**
 * 行の右端 (サイズ + 時刻 + 末尾スロット) の入れ物。コンテナ幅が `@2xs` (288px) 未満の面では
 * `basis-full` で行を 2 段に折り返し、名前へ幅を譲る (狭い右パネルでは 1 段に収めると
 * 名前の幅が尽きた後にアイコンと時刻が重なる。実測は docs/file-preview.md#時刻)。
 * `@2xs` 以上では `basis-auto` に戻って名前の右隣に並び、`justify-end` は幅が内容ぶんしかないため効かない。
 * `flex-wrap` は安全網: 2 段目 (行幅いっぱい) にも収まらない長いサイズ + 古い日付では、
 * メタをさらに折り返して ⋯ を切らない (行は 3 段になり得る)。
 */
function RowTail({ children }: { children: ReactNode }) {
  return (
    <div className="ml-auto flex basis-full flex-wrap items-center justify-end gap-x-1.5 gap-y-1 @2xs:basis-auto">
      {children}
    </div>
  );
}

function EntryRow({
  parent,
  absolutePathOf,
  entry,
  depth,
  tree,
  selected,
  canRename,
  readOnly,
  canRef,
  excludeNames,
  onShare,
  canShareSessionRoot,
  shareBlockedReason,
  revealPath,
  revealRef,
  onToggle,
  onSelect,
  onRename,
  onDelete,
  onDownload,
}: {
  parent: string;
  absolutePathOf: (path: string) => string | undefined;
  entry: FileEntry;
  depth: number;
  tree: FileTreeState;
  selected: string | null;
  canRename: boolean;
  readOnly: boolean;
  canRef: boolean;
  excludeNames: readonly string[];
  onShare?: (path: string) => void;
  /** root 直下の `index.html` 行に「このフォルダを共有」を出すか */
  canShareSessionRoot: boolean;
  /** 「共有」を押せない理由 (実行中など)。undefined なら押せる */
  shareBlockedReason?: string;
  revealPath: string | null;
  revealRef: RefObject<HTMLDivElement | null>;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
  onRename: (path: string, name: string) => void;
  onDelete: (path: string, type: "file" | "dir") => void;
  onDownload: (path: string, name: string, type: "file" | "dir") => void;
}) {
  const path = fileTreeChildPath(parent, entry.name);
  const absolutePath = absolutePathOf(path);
  const { copiedId, copyMessage, copyFailure } = useMessageCopy();
  const revealed = revealPath === path;
  const rowActions = (
    <EntryRowActions
      name={entry.name}
      type={entry.type}
      symlink={entry.symlink}
      canRename={canRename}
      readOnly={readOnly}
      excludeNames={excludeNames}
      absolutePath={absolutePath}
      canShare={onShare !== undefined}
      canShareSessionRoot={canShareSessionRoot}
      shareBlockedReason={shareBlockedReason}
      depth={depth}
      copied={copiedId === path}
      onCopyPath={() => void copyMessage(path, path)}
      onCopyAbsolutePath={() => {
        // 絶対パスを作れない行には項目が出ない。undefined で押されても何もしない
        if (absolutePath !== undefined) void copyMessage(absolutePath, path);
      }}
      onRename={() => onRename(path, entry.name)}
      onDelete={() => onDelete(path, entry.type)}
      onDownload={() => onDownload(path, entry.name, entry.type)}
      onShare={() => onShare?.(fileRowShareTarget({ type: entry.type, path, parent }))}
    />
  );

  if (entry.type === "dir") {
    const node = fileTreeDirectoryState(tree, path);
    const open = node?.open ?? false;
    // 一覧が届いたか。空のディレクトリは children: [] なので、未取得 (undefined) と区別する
    const loaded = node?.children !== undefined || node?.error !== undefined;
    // 待ちの印の行と内容は別の入れ物にする (下のコメント参照)。閉じている入れ物は inert にして、
    // 高さ 0 で見えない行をフォーカスさせない (inert は支援技術からも外す)
    const loadingOpen = open && !loaded;
    const contentOpen = open && loaded;
    return (
      <div>
        {/* 行全体を button にすると時刻が accessible name に混ざり、時刻のクリックでも開閉するため、
            ファイル行と同じ「div + flex-1 の操作 button」に分ける */}
        <div
          ref={revealed ? revealRef : undefined}
          style={
            {
              "--tree-indent": `${depth * INDENT + 8}px`,
              // 1 段表示でも名前へ 24px を残す (インデント + chevron 16 + gap 8 + folder 16 + gap 8 + 名前 24。
              // symlink のリンク印 33.45px + gap 8 を足す)。これを割る行は RowTail が次の段へ落ち、
              // shrink-0 のアイコン・リンク印が時刻・⋯ へ重なるのを防ぐ。行幅を超えないよう 100% で頭打ちにする
              // (2 段表示で深い階層のときに、最小幅が行からはみ出して切られるのを防ぐ)
              "--name-min-width": `min(calc(var(--tree-indent) + ${entry.symlink ? 114 : 72}px), 100%)`,
            } as CSSProperties
          }
          className={cn(
            "flex min-h-7.5 w-full flex-wrap items-center gap-x-1.5 gap-y-1 rounded-lg pr-2 text-xs text-ink transition-colors hover:bg-hover singleColumn:min-h-11",
            revealed && "ring-2 ring-focus ring-inset",
          )}
        >
          {/* 行全体を button にすると時刻が accessible name に混ざり、時刻のクリックでも開閉するため、
            ファイル行と同じ「div + flex-1 の操作 button」に分ける。最小幅の理由は行の --name-min-width を参照 */}
          <button
            type="button"
            aria-expanded={open}
            onClick={() => onToggle(path)}
            className="flex min-w-(--name-min-width) flex-1 items-center gap-2 py-1 pl-(--tree-indent) text-left singleColumn:min-h-11"
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
          <RowTail>
            <EntrySize bytes={entry.size} />
            <EntryTime at={entry.mtime} />
            {rowActions}
          </RowTail>
          <PathCopyFailure detail={copyFailure(path)} />
        </div>
        {/* 開閉は高さの遷移で見せる (styles/index.css の .tree-fold)。入れ物は開く前から置くので、
            初めて開く枝 (取得を待つ間) も 0fr から伸びる。閉じている間も取得済みの内容を残して
            同じ遷移で潰し、閉じている入れ物は inert にしてフォーカスも読み上げもさせない
            (高さ 0 で見えない行が支援技術に残るため)。
            待ちの印と内容は別の入れ物にする: 同じ入れ物の中で入れ替えると、開き切った後の高さ
            (1fr の解決値) は変わっても遷移が走らず、取得の完了が飛んで見える (入れ替えは 2 つの遷移を
            同じ長さで重ねる)。どちらも開く前から置くのは、mount した要素には遷移の前の値が無いため */}
        <div className="tree-fold" data-open={loadingOpen} inert={!loadingOpen}>
          <div>
            <MessageRow depth={depth + 1}>
              <LoadingMark />
            </MessageRow>
          </div>
        </div>
        <div className="tree-fold" data-open={contentOpen} inert={!contentOpen}>
          <div>
            {node?.error ? (
              <MessageRow depth={depth + 1} danger alert>
                {node.error}
              </MessageRow>
            ) : null}
            {node?.children ? (
              <Branch
                parent={path}
                absolutePathOf={absolutePathOf}
                node={node}
                depth={depth + 1}
                tree={tree}
                selected={selected}
                canRename={canRename}
                readOnly={readOnly}
                canRef={canRef}
                excludeNames={excludeNames}
                onShare={onShare}
                canShareSessionRoot={canShareSessionRoot}
                shareBlockedReason={shareBlockedReason}
                revealPath={revealPath}
                revealRef={revealRef}
                onToggle={onToggle}
                onSelect={onSelect}
                onRename={onRename}
                onDelete={onDelete}
                onDownload={onDownload}
              />
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  const isSelected = selected === path;
  return (
    // 行全体は選択、右端は ⋯ の操作メニュー。入れ子の button は作れないため、行は div にして button を並べる
    <div
      ref={revealed ? revealRef : undefined}
      draggable={canRef}
      onDragStart={
        canRef
          ? (event) => {
              // 添付 (Files) と区別する型と、他アプリへ落としても本文になる字面の両方を積む
              event.dataTransfer.setData(FILE_MENTION_MIME, path);
              event.dataTransfer.setData("text/plain", mentionText(path));
              event.dataTransfer.effectAllowed = "copy";
            }
          : undefined
      }
      title={canRef ? `${path}（ドラッグでチャットの参照にできます）` : undefined}
      style={
        {
          "--tree-indent": `${depth * INDENT + FILE_INDENT}px`,
          // 1 段表示でも名前へ 24px を残す (インデント + アイコン 16 + gap 8 + 名前 24。
          // symlink のリンク印 33.45px + gap 8 を足す)。これを割る行は RowTail が次の段へ落ち、
          // shrink-0 のアイコン・リンク印がサイズ・時刻・⋯ へ重なるのを防ぐ。行幅を超えないよう 100% で頭打ちにする
          // (2 段表示で深い階層のときに、最小幅が行からはみ出して切られるのを防ぐ)
          "--name-min-width": `min(calc(var(--tree-indent) + ${entry.symlink ? 90 : 48}px), 100%)`,
        } as CSSProperties
      }
      className={cn(
        "flex min-h-7.5 w-full flex-wrap items-center gap-x-1.5 gap-y-1 rounded-lg pr-2 text-xs transition-colors singleColumn:min-h-11",
        isSelected ? "bg-accent-wash text-accent-text" : "text-ink-soft hover:bg-hover hover:text-ink",
        revealed && "ring-2 ring-focus ring-inset",
      )}
    >
      <button
        type="button"
        aria-current={isSelected ? "true" : undefined}
        onClick={() => onSelect(path)}
        className="flex min-w-(--name-min-width) flex-1 items-center gap-2 py-1 pl-(--tree-indent) text-left singleColumn:min-h-11"
      >
        <FileIcon kind={fileKind(entry.name)} />
        <span className="min-w-0 truncate">{entry.name}</span>
        {entry.symlink ? <SymlinkMark /> : null}
      </button>
      <RowTail>
        <EntrySize bytes={entry.size} />
        <EntryTime at={entry.mtime} />
        {rowActions}
      </RowTail>
      <PathCopyFailure detail={copyFailure(path)} />
    </div>
  );
}

/**
 * 行の右端。時刻の右に ⋯ 1 個を並べる。項目を持たない行もスロットだけ空けて時刻の右端をそろえる。
 * 行の外に置くのは、コピーの状態 (⋯ のチェックと失敗の行) を行 (EntryRow) が持つためと、描画のテストで直接見るため。
 */
export function EntryRowActions({
  name,
  type,
  symlink,
  canRename,
  readOnly,
  excludeNames,
  absolutePath,
  canShare = false,
  canShareSessionRoot = false,
  shareBlockedReason,
  depth,
  copied,
  onCopyPath,
  onCopyAbsolutePath,
  onRename,
  onDelete,
  onDownload,
  onShare,
}: {
  name: string;
  type: "file" | "dir";
  symlink?: boolean;
  canRename: boolean;
  readOnly: boolean;
  /** ワークスペースの除外名（設定ストアの実効値）。除外名の行にはダウンロードを出さない */
  excludeNames: readonly string[];
  /** 行の絶対パス。undefined のときは「絶対パスをコピー」を出さない */
  absolutePath?: string;
  /** 「共有」(Cloudflare への静的公開) を出せる面か。未指定は出さない */
  canShare?: boolean;
  /** root 直下の `index.html` 行に「このフォルダを共有」を出すか。未指定は出さない */
  canShareSessionRoot?: boolean;
  /** 「共有」を押せない理由 (実行中など)。未指定は押せる */
  shareBlockedReason?: string;
  /** 行の深さ。0 = ツリーの root 直下 (root 専用の項目の出し分けに使う) */
  depth?: number;
  /** 直前のパスコピーが成功した行。⋯ をチェックに替える */
  copied: boolean;
  /** パスをコピーする。失敗の表示は行 (EntryRow) が受け持つ */
  onCopyPath: () => void;
  /** 絶対パスをコピーする。失敗の表示は行 (EntryRow) が受け持つ */
  onCopyAbsolutePath: () => void;
  onRename: () => void;
  onDelete: () => void;
  onDownload: () => void;
  onShare?: () => void;
}) {
  const actions = fileRowActions({
    name,
    type,
    symlink,
    canRename,
    readOnly,
    excludeNames,
    absolutePath,
    canShare,
    canShareSessionRoot,
    shareBlockedReason,
    depth,
  });
  // null = 行の操作領域ごと消す (現在返す面は無い)。空配列 = 領域は出すが項目が無い (空きスロット 1 個)
  if (actions === null) return null;
  if (actions.length === 0) return <EmptySlot />;
  const handlers: Record<FileRowActionKind, () => void> = {
    // 同じパスの再コピーは弾かない (冪等)。useMessageCopy が連番で古い結果だけを捨てる
    "copy-path": onCopyPath,
    "copy-absolute-path": onCopyAbsolutePath,
    // canShare が false の行には項目が出ないため、undefined の分岐は実際には通らない
    share: onShare ?? (() => {}),
    download: onDownload,
    rename: onRename,
    delete: onDelete,
  };
  return <RowMenu name={name} actions={actions} copied={copied} onSelect={(kind) => handlers[kind]()} />;
}

/** 項目を持たない行の末尾スロット。時刻の右端を ⋯ の行にそろえる。 */
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
      className="shrink-0 text-2xs whitespace-nowrap text-ink-ghost tabular-nums singleColumn:text-1xs"
    >
      {fileTimeLabel(at)}
    </time>
  );
}

/**
 * 行のサイズ。一覧が付けるのは通常ファイルとファイルへの symlink だけなので、`undefined` の行
 * (ディレクトリ・壊れた symlink) には出さない。表記は添付チップなどと同じ `formatBytes` で、`title`
 * に正確なバイト数を出す (`formatBytes` は不正な値で空文字を返すため、その場合も出さない)。
 */
function EntrySize({ bytes }: { bytes: number | undefined }) {
  if (bytes === undefined) return null;
  const label = formatBytes(bytes);
  if (label === "") return null;
  return (
    <span
      title={`${bytes.toLocaleString()} バイト`}
      className="shrink-0 text-2xs whitespace-nowrap text-ink-ghost tabular-nums singleColumn:text-1xs"
    >
      {label}
    </span>
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
  return (
    <span className="shrink-0 rounded border border-line px-1 text-3xs leading-4 text-ink-ghost singleColumn:text-1xs">
      リンク
    </span>
  );
}
