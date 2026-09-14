import { useEffect, useRef, useState, type FormEvent } from "react";
import { getFiles, type CreateProjectInput } from "../api";
import { parentWorkspacePath, projectChildPath, WORKSPACE_ROOT, workspaceBaseName } from "../lib/projectPath";
import type { FileEntry } from "../types";
import { CloseIcon, FolderIcon } from "./icons";

export type ProjectDialogProps = {
  onClose: () => void;
  /** 失敗は throw してフォームに出す */
  onCreate: (input: CreateProjectInput) => Promise<unknown>;
  compact?: boolean;
};

type ProjectMode = "create" | "register";

const MODES: { value: ProjectMode; label: string }[] = [
  { value: "create", label: "新規作成" },
  { value: "register", label: "既存を登録" },
];

/** root から GET /api/files を辿って親 (新規) / 対象 (登録) ディレクトリを選ぶ。一覧は移動のたびに取り直す */
export function ProjectDialog({ onClose, onCreate, compact = false }: ProjectDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const [mode, setMode] = useState<ProjectMode>("create");
  const [path, setPath] = useState(WORKSPACE_ROOT);
  const [directories, setDirectories] = useState<FileEntry[] | null>(null);
  const [listingError, setListingError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
        if (!cancelled) setListingError(err instanceof Error ? err.message : String(err));
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
      : { text: "登録はサーバーのメモリ内のみで、再起動すると消えます。", danger: false };

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
        onClose();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setBusy(false);
      }
    })();
  };

  const tabClass = (active: boolean) =>
    [
      "min-h-10 rounded-t-lg border-b-2 px-3.5 text-xs font-semibold transition-colors",
      active ? "border-focus text-accent-text" : "border-transparent text-ink-soft hover:text-ink",
    ].join(" ");

  const directoryRowClass =
    "flex min-h-9 w-full items-center gap-2 rounded-md px-2 text-left text-xs text-ink transition-colors hover:bg-hover";

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      aria-modal="true"
      aria-label="プロジェクトを追加"
      tabIndex={-1}
      className={[
        "flex flex-col overflow-hidden border-line bg-panel p-0 text-ink",
        compact
          ? "m-0 h-dvh w-screen max-h-none max-w-none rounded-none border-0"
          : "m-auto max-h-[min(88dvh,760px)] w-[min(560px,92vw)] rounded-xl border shadow-panel",
      ].join(" ")}
    >
      <header className="flex shrink-0 items-start justify-between gap-3 border-b border-line px-4 py-3.5">
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-ghost">PROJECT</div>
          <h2 className="text-base font-semibold text-ink-strong">プロジェクトを追加</h2>
        </div>
        <button type="button" onClick={onClose} className="btn-quiet" disabled={busy}>
          <CloseIcon />
          閉じる
        </button>
      </header>

      <div role="tablist" aria-label="プロジェクトの追加方法" className="flex shrink-0 gap-1 border-b border-line px-3">
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

      <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
        <div className="scrollbar-thin grid min-h-0 flex-1 content-start gap-3.5 overflow-y-auto px-4 py-3.5">
          <div className="grid gap-1.5">
            <div className="text-[10px] font-semibold uppercase tracking-widest text-ink-faint">
              {mode === "create" ? "親ディレクトリ" : "登録するディレクトリ"}
            </div>
            <code className="block truncate rounded-lg border border-line bg-soft px-2.5 py-2 text-[11px] text-ink-soft">
              {path === WORKSPACE_ROOT ? "ワークスペース root" : path}
            </code>
            {/* 一覧だけをスクロールさせ、名前の入力と送信ボタンを常に見える位置に残す */}
            <div className="scrollbar-thin max-h-[42dvh] overflow-y-auto rounded-lg border border-line bg-soft p-1">
              {path !== WORKSPACE_ROOT ? (
                <button type="button" onClick={() => changePath(parentWorkspacePath(path))} className={directoryRowClass}>
                  <span aria-hidden className="grid size-4 shrink-0 place-items-center text-ink-faint">
                    ↑
                  </span>
                  <span className="min-w-0 truncate text-ink-soft">上の階層へ</span>
                </button>
              ) : null}
              {listingError ? (
                <p role="alert" className="px-2 py-1.5 text-[11px] leading-relaxed text-danger-text">
                  {listingError}
                </p>
              ) : directories === null ? (
                <p className="px-2 py-1.5 text-[11px] text-ink-muted">読み込み中…</p>
              ) : directories.length === 0 ? (
                <p className="px-2 py-1.5 text-[11px] text-ink-muted">サブディレクトリはありません</p>
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
            <label htmlFor="project-name" className="text-[10px] font-semibold uppercase tracking-widest text-ink-faint">
              {mode === "create" ? "名前" : "表示名"}
            </label>
            {/* compact は iOS Safari の focus 時ズームを避けるために 16px 以上にする */}
            <input
              id="project-name"
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
              disabled={busy}
              placeholder={mode === "create" ? "新しいディレクトリ名" : "ディレクトリ名"}
              className={["field", compact ? "text-[16px]" : "text-xs"].join(" ")}
            />
            <p className="text-[11px] leading-relaxed text-ink-muted">
              {mode === "create"
                ? `ワークスペース内に ${projectChildPath(path, name.trim() || "…")} を作成します。`
                : "選択中の既存ディレクトリを登録します。ディレクトリの中身は変更しません。"}
            </p>
          </div>
        </div>

        <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-3">
          <p
            role={footerNote.danger ? "alert" : undefined}
            className={[
              "min-w-0 flex-1 text-[11px] leading-relaxed",
              footerNote.danger ? "text-danger-text" : "text-ink-muted",
            ].join(" ")}
          >
            {footerNote.text}
          </p>
          <div className="flex items-center gap-2">
            <button type="button" onClick={onClose} className="btn-quiet" disabled={busy}>
              キャンセル
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              className="inline-flex min-h-9 items-center justify-center rounded-lg bg-accent px-4 text-xs font-semibold text-on-accent transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-45"
            >
              {mode === "create" ? "作成" : "登録"}
            </button>
          </div>
        </footer>
      </form>
    </dialog>
  );
}
