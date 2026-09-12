import { useEffect, useRef, useState, type ReactNode } from "react";
import { getFiles } from "../api";
import {
  applyFileTreeError,
  applyFileTreeListing,
  beginFileTreeLoad,
  createFileTreeState,
  FILE_TREE_ROOT,
  fileTreeChildPath,
  invalidateFileTree,
  pendingFileTreeDirectories,
  toggleFileTreeDirectory,
  type FileTreeDirectoryState,
  type FileTreeState,
} from "../lib/fileTree";
import type { FileEntry } from "../types";
import { ArrowLeftIcon, ChevronIcon, FileIcon, FolderIcon, RefreshIcon } from "./icons";

export type FileTreeScreenProps = {
  onClose: () => void;
  /** 作業ディレクトリの絶対パス (health.cwd または SessionPayload.cwd) */
  cwd: string;
  /** compact layout では内側の枠を絞らず全幅にする */
  compact?: boolean;
};

/** 1 段あたりのインデント (px) */
const INDENT = 16;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 作業ディレクトリのファイルツリー。ManagerScreen と同じフルスクリーンの dialog にして、
 * メイン画面のレイアウトは変えない (将来この中でツリー + プレビューの 2 ペインへ広げる)。
 * ディレクトリは展開時に初めて取得し、ファイル監視はしない (更新は「再読み込み」のみ)。
 */
export function FileTreeScreen({ onClose, cwd, compact = false }: FileTreeScreenProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  /** 開く前にフォーカスしていた要素 (閉じたときに戻す) */
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const [tree, setTree] = useState<FileTreeState>(createFileTreeState);
  const [selected, setSelected] = useState<string | null>(null);
  // StrictMode の effect 二重実行と、取得中の再読み込みで同じディレクトリを二重に要求しない
  const inFlightRef = useRef<Set<string>>(new Set());

  // モーダル dialog として開く。背面の inert 化と Tab のフォーカス拘束、Escape での終了は showModal() の標準挙動に任せる。
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) {
      previousFocusRef.current = document.activeElement as HTMLElement | null;
      dialog.showModal();
    } else if (!dialog.contains(document.activeElement)) {
      dialog.focus();
    }
    return () => previousFocusRef.current?.focus();
  }, []);

  // 未取得のディレクトリを表示順に取得する。状態遷移は lib/fileTree.ts の純関数だけが行う。
  useEffect(() => {
    const pending = pendingFileTreeDirectories(tree).filter((path) => !inFlightRef.current.has(path));
    if (pending.length === 0) return;
    for (const path of pending) inFlightRef.current.add(path);
    setTree((prev) => pending.reduce((acc, path) => beginFileTreeLoad(acc, path), prev));
    for (const path of pending) {
      void (async () => {
        try {
          const listing = await getFiles(path);
          setTree((prev) => applyFileTreeListing(prev, path, listing));
        } catch (error) {
          setTree((prev) => applyFileTreeError(prev, path, errorText(error)));
        } finally {
          inFlightRef.current.delete(path);
        }
      })();
    }
  }, [tree]);

  const reload = () => {
    setSelected(null);
    setTree((prev) => invalidateFileTree(prev));
  };

  const toggle = (path: string) => {
    setTree((prev) => toggleFileTreeDirectory(prev, path));
  };

  const root = tree[FILE_TREE_ROOT] ?? { open: true, loading: false };

  return (
    // フルスクリーンのモーダル dialog (ManagerScreen と同じ扱い)
    <dialog
      ref={dialogRef}
      onClose={onClose}
      aria-modal="true"
      aria-label="作業ディレクトリのファイル"
      tabIndex={-1}
      className="m-0 h-dvh max-h-none w-screen max-w-none overflow-hidden rounded-none border-0 bg-base p-0 text-ink"
    >
      <div
        className={[
          // 明示的な minmax(0,1fr) で列を viewport 幅に固定する (auto だと nowrap のパス文字列に引き伸ばされ、ヘッダがはみ出す)
          "mx-auto grid h-full min-h-0 grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)] overflow-hidden",
          compact ? "w-full" : "w-full max-w-[720px] border-x border-line",
        ].join(" ")}
      >
        <header className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 border-b border-line px-4 py-3.5">
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-ghost">WORKSPACE</div>
            <h2 className="text-base font-semibold text-ink-strong">作業ディレクトリ</h2>
            <code className="block truncate text-[11px] leading-normal text-ink-muted">{cwd || "読み込み中…"}</code>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={reload} className="btn-quiet">
              <RefreshIcon />
              再読み込み
            </button>
            <button type="button" onClick={onClose} className="btn-quiet">
              <ArrowLeftIcon />
              戻る
            </button>
          </div>
        </header>

        <div className="scrollbar-thin min-h-0 overflow-x-hidden overflow-y-auto px-2 py-3">
          {root.error ? (
            <MessageRow depth={0} danger alert>
              {root.error}
            </MessageRow>
          ) : null}
          {root.children ? (
            <Branch
              parent={FILE_TREE_ROOT}
              node={root}
              depth={0}
              tree={tree}
              selected={selected}
              onToggle={toggle}
              onSelect={setSelected}
            />
          ) : root.error ? null : (
            <MessageRow depth={0}>読み込み中…</MessageRow>
          )}
        </div>
      </div>
    </dialog>
  );
}

type BranchProps = {
  parent: string;
  node: FileTreeDirectoryState;
  depth: number;
  tree: FileTreeState;
  selected: string | null;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
};

function Branch({ parent, node, depth, tree, selected, onToggle, onSelect }: BranchProps) {
  const entries = node.children ?? [];
  return (
    <div className="grid gap-0.5">
      {entries.length === 0 ? <MessageRow depth={depth}>（空）</MessageRow> : null}
      {entries.map((entry) => (
        <EntryRow
          key={entry.name}
          parent={parent}
          entry={entry}
          depth={depth}
          tree={tree}
          selected={selected}
          onToggle={onToggle}
          onSelect={onSelect}
        />
      ))}
      {node.truncated ? (
        <MessageRow depth={depth}>上限のため {entries.length} 件のみ表示しています</MessageRow>
      ) : null}
    </div>
  );
}

function EntryRow({
  parent,
  entry,
  depth,
  tree,
  selected,
  onToggle,
  onSelect,
}: {
  parent: string;
  entry: FileEntry;
  depth: number;
  tree: FileTreeState;
  selected: string | null;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
}) {
  const path = fileTreeChildPath(parent, entry.name);

  if (entry.type === "dir") {
    const node = tree[path];
    const open = node?.open ?? false;
    return (
      <div>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => onToggle(path)}
          style={{ paddingLeft: `${depth * INDENT + 8}px` }}
          className="flex min-h-9 w-full items-center gap-2 rounded-lg pr-2 text-left text-xs text-ink transition-colors hover:bg-hover"
        >
          <span
            className={[
              "grid size-4 shrink-0 place-items-center text-ink-faint transition-transform",
              open ? "rotate-90" : "",
            ].join(" ")}
          >
            <ChevronIcon />
          </span>
          <FolderIcon />
          <span className="min-w-0 flex-1 truncate">{entry.name}</span>
          {entry.symlink ? <SymlinkMark /> : null}
        </button>
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
                onToggle={onToggle}
                onSelect={onSelect}
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
    <button
      type="button"
      aria-current={isSelected ? "true" : undefined}
      onClick={() => onSelect(path)}
      style={{ paddingLeft: `${depth * INDENT + 32}px` }}
      className={[
        "flex min-h-9 w-full items-center gap-2 rounded-lg pr-2 text-left text-xs transition-colors",
        isSelected ? "bg-accent-wash text-accent-text" : "text-ink-soft hover:bg-hover hover:text-ink",
      ].join(" ")}
    >
      <FileIcon />
      <span className="min-w-0 flex-1 truncate">{entry.name}</span>
      {entry.symlink ? <SymlinkMark /> : null}
    </button>
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
      style={{ paddingLeft: `${depth * INDENT + 32}px` }}
      className={[
        "py-1.5 pr-2 text-[11px] leading-relaxed break-words",
        danger ? "text-danger-text" : "text-ink-muted",
      ].join(" ")}
    >
      {children}
    </div>
  );
}

/** root 外を指す symlink は開くと 400 になるため、一覧の時点で印を付ける */
function SymlinkMark() {
  return (
    <span className="shrink-0 rounded border border-line px-1 text-[9px] leading-4 text-ink-ghost">リンク</span>
  );
}
