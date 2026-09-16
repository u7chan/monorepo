import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { getFiles } from "../api";
import {
  applyFileTreeError,
  applyFileTreeListing,
  beginFileTreeLoad,
  createFileTreeState,
  FILE_TREE_ROOT,
  fileTreeChildPath,
  fileTreeFetchPath,
  invalidateFileTree,
  normalizeFileTreeRoot,
  pendingFileTreeDirectories,
  toggleFileTreeDirectory,
  type FileTreeDirectoryState,
  type FileTreeState,
} from "../lib/fileTree";
import type { FileEntry } from "../types";
import { SettingsPageLayout, type SettingsPageProps } from "./SettingsPageLayout";
import { ChevronIcon, FileIcon, FolderIcon, RefreshIcon } from "./icons";

export type FileTreePageProps = SettingsPageProps & {
  /** ワークスペース root 相対 ("" や絶対パスは root へ畳まれる) */
  cwd: string;
};

const INDENT = 16;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 作業ディレクトリのファイルツリー。渡された `cwd` を root として `GET /api/files` を辿る (配下は `<cwd>/<name>`)。
 * メイン領域のページに置く。ヘッダもツリーも画面幅いっぱいに使い、行は深さに比例したインデントだけを持つ
 * (行のインデントは深さで決まるため、長い名前は truncate し横スクロールは出さない)。
 * ディレクトリは展開時に初めて取得し、ファイル監視はしない (更新は「再読み込み」のみ)。
 */
export function FileTreePage({ cwd, compact = false, onBack, onOpenNav }: FileTreePageProps) {
  const rootPath = normalizeFileTreeRoot(cwd);
  const [tree, setTree] = useState<FileTreeState>(createFileTreeState);
  const [selected, setSelected] = useState<string | null>(null);
  // StrictMode の effect 二重実行と、取得中の再読み込みで同じディレクトリを二重に要求しない
  const inFlightRef = useRef<Set<string>>(new Set());

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

  const reload = () => {
    setSelected(null);
    setTree((prev) => invalidateFileTree(prev));
  };

  const toggle = (path: string) => {
    setTree((prev) => toggleFileTreeDirectory(prev, path));
  };

  const root = tree[FILE_TREE_ROOT] ?? { open: true, loading: false };

  return (
    <SettingsPageLayout
      eyebrow="WORKSPACE"
      title="作業ディレクトリ"
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
        <button type="button" onClick={reload} className="btn-quiet">
          <RefreshIcon />
          再読み込み
        </button>
      }
    >
      {/* ツリーは行のインデントだけを持ち、幅は画面いっぱいに使う */}
      <div className="min-h-0 scrollbar-thin overflow-x-hidden overflow-y-auto px-3 py-3">
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
    </SettingsPageLayout>
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
          onToggle={onToggle}
          onSelect={onSelect}
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
          style={{ "--tree-indent": `${depth * INDENT + 8}px` } as CSSProperties}
          className="flex min-h-9 w-full items-center gap-2 rounded-lg pr-2 pl-(--tree-indent) text-left text-xs text-ink transition-colors hover:bg-hover"
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
          <span className="min-w-0 truncate">{entry.name}</span>
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
      style={{ "--tree-indent": `${depth * INDENT + 32}px` } as CSSProperties}
      className={[
        "flex min-h-9 w-full items-center gap-2 rounded-lg pr-2 pl-(--tree-indent) text-left text-xs transition-colors",
        isSelected ? "bg-accent-wash text-accent-text" : "text-ink-soft hover:bg-hover hover:text-ink",
      ].join(" ")}
    >
      <FileIcon />
      <span className="min-w-0 truncate">{entry.name}</span>
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
      style={{ "--tree-indent": `${depth * INDENT + 32}px` } as CSSProperties}
      className={[
        "py-1.5 pr-2 pl-(--tree-indent) text-1xs leading-relaxed break-words",
        danger ? "text-danger-text" : "text-ink-muted",
      ].join(" ")}
    >
      {children}
    </div>
  );
}

/** root 外を指す symlink は開くと 400 になるため、一覧の時点で印を付ける */
function SymlinkMark() {
  return <span className="shrink-0 rounded border border-line px-1 text-3xs leading-4 text-ink-ghost">リンク</span>;
}
