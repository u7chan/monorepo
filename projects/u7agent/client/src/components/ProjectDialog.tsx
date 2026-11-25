import { useEffect, useRef, useState, type FormEvent } from "react";
import type { CreateProjectInput } from "../api/sessions";
import { getFiles } from "../api/files";
import { cn } from "../lib/cn";
import { messageFor } from "../lib/errors";
import { parentWorkspacePath, projectChildPath, WORKSPACE_ROOT, workspaceBaseName } from "../lib/projectPath";
import type { FileEntry } from "../types";
import { FolderIcon } from "./icons";
import { WorkDialog } from "./WorkDialog";
import type { ModalDialogHandle } from "./ModalDialog";

export type ProjectDialogProps = {
  onClose: () => void;
  /** 失敗は throw してフォームに出す */
  onCreate: (input: CreateProjectInput) => Promise<unknown>;
  singleColumn?: boolean;
};

type ProjectMode = "create" | "register";

const MODES: { value: ProjectMode; label: string }[] = [
  { value: "create", label: "新規作成" },
  { value: "register", label: "既存を登録" },
];

/** root から GET /api/files を辿って親 (新規) / 対象 (登録) ディレクトリを選ぶ。一覧は移動のたびに取り直す */
export function ProjectDialog({ onClose, onCreate, singleColumn = false }: ProjectDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const shellRef = useRef<ModalDialogHandle | null>(null);
  const [mode, setMode] = useState<ProjectMode>("create");
  const [path, setPath] = useState(WORKSPACE_ROOT);
  const [directories, setDirectories] = useState<FileEntry[] | null>(null);
  const [listingError, setListingError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 選択中のディレクトリが外部で消えていたら、ここでエラーとして見える (自動更新はしない)
  useEffect(() => {
    let cancelled = false;
    setDirectories(null);
    setListingError(null);
    void (async () => {
      try {
        const listing = await getFiles(path);
        if (!cancelled) setDirectories(listing.entries.filter((entry) => entry.type === "dir"));
      } catch (err) {
        if (!cancelled) setListingError(messageFor(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path]);

  const changeMode = (next: ProjectMode) => {
    setMode(next);
    setError(null);
    // 登録は選んだディレクトリ名を既定にし、新規は入力させる (中身の意味が変わるので持ち越さない)
    setName(next === "register" ? workspaceBaseName(path) : "");
  };

  const changePath = (next: string) => {
    setPath(next);
    setError(null);
    if (mode === "register") setName(workspaceBaseName(next));
  };

  // root は未所属チャットの作業場所なので登録できない (サーバーも 400 を返す)
  const rootSelected = mode === "register" && path === WORKSPACE_ROOT;
  const canSubmit = !busy && !rootSelected && name.trim().length > 0;
  const footerNote = error
    ? { text: error, danger: true }
    : rootSelected
      ? { text: "ワークスペース root は登録できません (未所属チャットの作業場所です)。", danger: false }
      : { text: "登録はサーバーに保存され、再起動後も残ります。", danger: false };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) return;
    const trimmed = name.trim();
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        // cwd の正規化と実在確認はサーバーが行う (エラー文言はそのままフォームに出す)
        await onCreate(
          mode === "create"
            ? { cwd: projectChildPath(path, trimmed), name: trimmed, create: true }
            : { cwd: path, name: trimmed },
        );
        // 閉じるまで busy を戻さない (成功後に二重送信できないように)
        shellRef.current?.requestClose();
      } catch (err) {
        setError(messageFor(err));
        setBusy(false);
      }
    })();
  };

  const tabClass = (active: boolean) => cn("tab-item", active && "tab-item-active");

  const directoryRowClass = cn(
    "flex min-h-9 w-full items-center gap-2 rounded-md px-2 text-left text-xs text-ink transition-colors hover:bg-hover",
  );

  return (
    <WorkDialog
      eyebrow="PROJECT"
      title="プロジェクトを追加"
      busy={busy}
      handleRef={shellRef}
      onClose={onClose}
      onSubmit={submit}
      initialFocusRef={cancelRef}
      note={footerNote}
      submit={{ label: mode === "create" ? "作成" : "登録", tone: "primary", disabled: !canSubmit }}
      // 追加方法の切替は本文の外に置く (本文をスクロールしても常に見える)
      toolbar={
        <div
          role="tablist"
          aria-label="プロジェクトの追加方法"
          className="flex shrink-0 gap-1 border-b border-line px-3"
        >
          {MODES.map((item) => (
            <button
              key={item.value}
              type="button"
              role="tab"
              aria-selected={mode === item.value}
              onClick={() => changeMode(item.value)}
              className={tabClass(mode === item.value)}
              disabled={busy}
            >
              {item.label}
            </button>
          ))}
        </div>
      }
      width="wide"
      body="fields"
      singleColumn={singleColumn}
    >
      <div className="grid gap-1.5">
        <div className="text-2xs font-semibold tracking-widest text-ink-faint uppercase">
          {mode === "create" ? "親ディレクトリ" : "登録するディレクトリ"}
        </div>
        <code className="block truncate rounded-lg border border-line bg-soft px-2.5 py-2 text-1xs text-ink-soft">
          {path === WORKSPACE_ROOT ? "ワークスペース root" : path}
        </code>
        {/* 一覧だけをスクロールさせ、名前の入力と送信ボタンを常に見える位置に残す */}
        <div className="max-h-[42dvh] scrollbar-thin overflow-y-auto rounded-lg border border-line bg-soft p-1">
          {path !== WORKSPACE_ROOT ? (
            <button type="button" onClick={() => changePath(parentWorkspacePath(path))} className={directoryRowClass}>
              <span aria-hidden className="grid size-4 shrink-0 place-items-center text-ink-faint">
                ↑
              </span>
              <span className="min-w-0 truncate text-ink-soft">上の階層へ</span>
            </button>
          ) : null}
          {listingError ? (
            <p role="alert" className="px-2 py-1.5 text-1xs leading-relaxed text-danger-text">
              {listingError}
            </p>
          ) : directories === null ? (
            <p className="px-2 py-1.5 text-1xs text-ink-muted">読み込み中…</p>
          ) : directories.length === 0 ? (
            <p className="px-2 py-1.5 text-1xs text-ink-muted">サブディレクトリはありません</p>
          ) : (
            directories.map((entry) => (
              <button
                key={entry.name}
                type="button"
                onClick={() => changePath(projectChildPath(path, entry.name))}
                className={directoryRowClass}
              >
                <span className="shrink-0 text-ink-faint">
                  <FolderIcon />
                </span>
                <span className="min-w-0 truncate">{entry.name}</span>
              </button>
            ))
          )}
        </div>
      </div>

      <div className="grid gap-1.5">
        <label htmlFor="project-name" className="text-2xs font-semibold tracking-widest text-ink-faint uppercase">
          {mode === "create" ? "名前" : "表示名"}
        </label>
        <input
          id="project-name"
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
          disabled={busy}
          placeholder={mode === "create" ? "新しいディレクトリ名" : "ディレクトリ名"}
          className={cn("field", singleColumn ? "text-md" : "text-xs")}
        />
        <p className="text-1xs leading-relaxed text-ink-muted">
          {mode === "create"
            ? `ワークスペース内に ${projectChildPath(path, name.trim() || "…")} を作成します。`
            : "選択中の既存ディレクトリを登録します。ディレクトリの中身は変更しません。"}
        </p>
      </div>
    </WorkDialog>
  );
}
