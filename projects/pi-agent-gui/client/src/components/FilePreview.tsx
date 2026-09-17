import { useEffect, useMemo, useRef, useState, type Ref } from "react";
import { fileHtmlPreviewUrl, getFilePreview } from "../api";
import { cn } from "../lib/cn";
import { buildPreviewCode, isHtmlPath, previewLineNumbers } from "../lib/fileCode";
import {
  dropClosedPreviewModes,
  dropClosedPreviews,
  fileTabLabels,
  previewModeFor,
  readPreview,
  withPreviewMode,
  type PreviewMode,
  type PreviewModes,
  type PreviewResults,
} from "../lib/fileTabs";
import { fileTreeFetchPath } from "../lib/fileTree";
import { CloseIcon } from "./icons";

const PREVIEW_MODES: { value: PreviewMode; label: string }[] = [
  { value: "source", label: "ソース" },
  { value: "preview", label: "プレビュー" },
];

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type FilePreviewProps = {
  /** 開いているタブ (ページ root 相対・開いた順) */
  paths: string[];
  /** 表示中のタブ。paths の中にある */
  activePath: string;
  /** ページの root。fileTree と同じ単位で、取得時に GET /api/files の path へ変換する */
  rootPath: string;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
};

/**
 * タブ付きのプレビュー。本文はタブごとに保持し、切替で取り直さない (タブを開いただけでは取得しない)。
 * 親が `key` を変えたとき (一覧の再読み込み) は全タブの本文を捨てて取り直す。
 */
export function FilePreview({ paths, activePath, rootPath, onSelect, onClose }: FilePreviewProps) {
  const [results, setResults] = useState<PreviewResults>({});
  const [modes, setModes] = useState<PreviewModes>({});
  const activeTabRef = useRef<HTMLDivElement | null>(null);
  const labels = fileTabLabels(paths);
  const fetchPath = fileTreeFetchPath(rootPath, activePath);
  const result = readPreview(results, activePath);
  const text = result?.text;
  const mode = previewModeFor(modes, activePath);
  // HTML を描画している間はソースを取得しない (プレビューは iframe が自分で取る)
  const showHtml = mode === "preview" && isHtmlPath(activePath);
  // ハイライトは表示中のタブの本文についてだけ計算する (タブごとに保持しない理由は docs/file-preview.md)
  const code = useMemo(
    () => (showHtml || text === undefined ? null : buildPreviewCode(text, activePath)),
    [showHtml, text, activePath],
  );

  // 表示中のタブがバーの外 (横スクロール) へ隠れないようにする
  useEffect(() => {
    activeTabRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activePath]);

  // 表示中のタブだけ取得する。取得中に切り替えたら中断して結果を捨てる (再表示で取り直す)
  useEffect(() => {
    if (showHtml) return;
    if (readPreview(results, activePath)) return;
    const controller = new AbortController();
    void getFilePreview(fetchPath, controller.signal).then(
      (value) => {
        if (!controller.signal.aborted) setResults((prev) => ({ ...prev, [activePath]: value }));
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setResults((prev) => ({ ...prev, [activePath]: { error: errorText(error) } }));
      },
    );
    return () => controller.abort();
  }, [activePath, fetchPath, results, showHtml]);

  useEffect(() => {
    setResults((prev) => dropClosedPreviews(prev, paths));
    setModes((prev) => dropClosedPreviewModes(prev, paths));
  }, [paths]);

  return (
    // 幅が足りないときはツリーの下 (border-t)、コンテナが @2xl 以上ならツリーの右 (border-l) へ置く
    <section
      aria-label="ファイルプレビュー"
      className="flex min-h-40 min-w-0 flex-1 flex-col border-t border-line @2xl:min-h-0 @2xl:border-t-0 @2xl:border-l"
    >
      {/* タブは横スクロールにし、増えても行の高さと本文の幅を変えない */}
      <div className="flex shrink-0 scrollbar-thin items-stretch gap-1 overflow-x-auto border-b border-line px-2 py-1.5">
        {paths.map((path, index) => (
          <FileTab
            key={path}
            name={labels[index]}
            path={fileTreeFetchPath(rootPath, path)}
            active={path === activePath}
            rootRef={path === activePath ? activeTabRef : undefined}
            onSelect={() => onSelect(path)}
            onClose={() => onClose(path)}
          />
        ))}
      </div>
      <div className="flex items-center gap-3 px-4 py-1.5">
        <code className="min-w-0 flex-1 truncate text-1xs text-ink-muted" title={fetchPath}>
          {fetchPath}
        </code>
        {isHtmlPath(activePath) ? (
          <PreviewModeToggle
            mode={mode}
            onChange={(next) => setModes((prev) => withPreviewMode(prev, activePath, next))}
          />
        ) : null}
        {code !== null && code.lineCount > 0 ? (
          <span className="shrink-0 text-3xs text-ink-ghost">
            {code.highlight?.lang ?? "text"} · {code.lineCount} 行
          </span>
        ) : null}
      </div>
      {result?.error && !showHtml ? (
        <p role="alert" className="px-4 py-2 text-xs break-words text-danger-text">
          {result.error}
        </p>
      ) : showHtml ? (
        // 相対パスのアセットは読めない (自己完結した HTML だけを描画する)。sandbox は常に allow-scripts
        <iframe
          src={fileHtmlPreviewUrl(fetchPath)}
          title={`${fetchPath} のプレビュー`}
          sandbox="allow-scripts"
          className="min-h-0 w-full flex-1 border-0 bg-white"
        />
      ) : code === null ? (
        <p role="status" className="px-4 py-2 text-xs text-ink-muted">
          読み込み中…
        </p>
      ) : code.lineCount === 0 ? (
        <p className="px-4 py-2 text-xs text-ink-muted">（空のファイル）</p>
      ) : (
        // 行番号は本文と別の列にする。番号は行ごとの要素ではなく 1 つのテキストノードで出す
        <div tabIndex={0} className="file-code min-h-0 flex-1 scrollbar-thin font-mono">
          <div className="file-code-row">
            <div aria-hidden="true" className="file-code-gutter">
              {previewLineNumbers(code.lineCount)}
            </div>
            <pre className="file-code-body">
              <code>
                {code.highlight === null
                  ? code.text
                  : code.highlight.tokens.map((token, index) =>
                      token.kind === "plain" ? (
                        token.text
                      ) : (
                        <span key={index} className={`tok-${token.kind}`}>
                          {token.text}
                        </span>
                      ),
                    )}
              </code>
            </pre>
          </div>
        </div>
      )}
    </section>
  );
}

function PreviewModeToggle({ mode, onChange }: { mode: PreviewMode; onChange: (mode: PreviewMode) => void }) {
  return (
    <div
      role="group"
      aria-label="表示の切替"
      className="flex shrink-0 items-center gap-0.5 rounded-lg border border-line p-0.5"
    >
      {PREVIEW_MODES.map((item) => (
        <button
          key={item.value}
          type="button"
          aria-pressed={mode === item.value}
          onClick={() => onChange(item.value)}
          className={cn(
            "rounded-md px-2 py-0.5 text-3xs transition-colors",
            mode === item.value ? "bg-accent-wash text-accent-text" : "text-ink-soft hover:bg-hover hover:text-ink",
          )}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

function FileTab({
  name,
  path,
  active,
  rootRef,
  onSelect,
  onClose,
}: {
  name: string;
  /** 全体パス (tooltip と aria-label 用。同名タブを読み上げでも区別する) */
  path: string;
  active: boolean;
  /** 表示中のタブだけが持つ (バーへの追従用) */
  rootRef?: Ref<HTMLDivElement>;
  onSelect: () => void;
  onClose: () => void;
}) {
  return (
    <div
      ref={rootRef}
      className={cn(
        "flex min-h-7.5 shrink-0 items-center gap-0.5 rounded-lg pr-0.5 pl-2 text-xs transition-colors",
        active ? "bg-accent-wash text-accent-text" : "text-ink-soft hover:bg-hover hover:text-ink",
      )}
    >
      <button
        type="button"
        aria-current={active ? "true" : undefined}
        aria-label={path}
        title={path}
        onClick={onSelect}
        className="max-w-40 min-w-0 truncate py-1 text-left"
      >
        {name}
      </button>
      <button
        type="button"
        aria-label={`${path} を閉じる`}
        onClick={onClose}
        className="grid size-6 shrink-0 place-items-center rounded-md text-ink-faint transition-colors hover:bg-hover hover:text-ink"
      >
        <CloseIcon />
      </button>
    </div>
  );
}
