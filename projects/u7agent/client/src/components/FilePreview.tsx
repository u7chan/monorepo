import { useEffect, useMemo, useRef, useState, type MouseEvent, type Ref } from "react";
import { fileHtmlPreviewUrl, fileRawUrl, fileStoragePreviewUrl, getFilePreview } from "../api";
import { useMessageCopy } from "../hooks/useMessageCopy";
import { isImageName } from "../lib/attachments";
import { cn } from "../lib/cn";
import { lineNumbers } from "../lib/codeLines";
import { buildPreviewCode, isHtmlPath, previewCopyText } from "../lib/fileCode";
import {
  dropClosedPreviews,
  fileTabLabels,
  isMiddleClick,
  previewModeFor,
  previewOriginFor,
  readPreview,
  type PreviewMode,
  type PreviewModes,
  type PreviewOrigin,
  type PreviewOrigins,
  type PreviewResults,
} from "../lib/fileTabs";
import { fileTreeBreadcrumbs, fileTreeFetchPath } from "../lib/fileTree";
import { imageMetaLabel, type ImageDimensions } from "../lib/imageMeta";
import { ToggleSwitch } from "./ToggleSwitch";
import { CopyButton } from "./chat/CopyButton";
import { CloseIcon, ExternalLinkIcon } from "./icons";

const PREVIEW_MODES: { value: PreviewMode; label: string }[] = [
  { value: "source", label: "ソース" },
  { value: "preview", label: "プレビュー" },
];

const PREVIEW_ORIGIN_ON_NOTE = "別オリジンで開き直し、localStorage などを使えるようにします";
const PREVIEW_ORIGIN_OFF_NOTE = "アプリと同じオリジンで開き直し、localStorage などを使えなくします";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type FilePreviewProps = {
  /** 一覧と本文の再読み込みの版。画像の raw URL にも使う */
  previewVersion: number;
  /** 開いているタブ (ページ root 相対・開いた順) */
  paths: string[];
  /** 表示中のタブ。paths の中にある */
  activePath: string;
  /** ページの root。fileTree と同じ単位で、取得時に GET /api/files の path へ変換する */
  rootPath: string;
  /** タブごとの表示モード。親が持つ (再読み込みの remount で選択を失わないため) */
  modes: PreviewModes;
  /** タブごとのプレビューの配信元。親が持つ (表示モードと同じく remount で失わないため) */
  origins: PreviewOrigins;
  /** プレビュー オリジンのブラウザから見たポート (health の filePreviewPort)。未取得の間は切替を無効にする */
  filePreviewPort?: number;
  /** 表示中のタブのサイズ (ツリーの取得済みの行から引く)。未取得は undefined で、画像のメタは寸法だけになる */
  activeSize?: number;
  /** パンくずのクリック。ツリーと同じ画面 root 相対パスを渡す (ツリーでその位置を示す) */
  onReveal: (path: string) => void;
  onModeChange: (path: string, mode: PreviewMode) => void;
  onOriginChange: (path: string, origin: PreviewOrigin) => void;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
};

/**
 * タブ付きのプレビュー。本文はタブごとに保持し、切替で取り直さない (タブを開いただけでは取得しない)。
 * 親が `key` を変えたとき (一覧の再読み込み) は全タブの本文を捨てて取り直す。
 */
export function FilePreview({
  previewVersion,
  paths,
  activePath,
  rootPath,
  modes,
  origins,
  filePreviewPort,
  activeSize,
  onReveal,
  onModeChange,
  onOriginChange,
  onSelect,
  onClose,
}: FilePreviewProps) {
  const [results, setResults] = useState<PreviewResults>({});
  // 読み込みが終わった画像の寸法。パスを一緒に持ち、タブを切り替えたら前のタブの値を出さない
  const [loadedImage, setLoadedImage] = useState<{ path: string; dimensions: ImageDimensions } | null>(null);
  const activeTabRef = useRef<HTMLDivElement | null>(null);
  const labels = fileTabLabels(paths);
  const fetchPath = fileTreeFetchPath(rootPath, activePath);
  const result = readPreview(results, activePath);
  const text = result?.text;
  const mode = previewModeFor(modes, activePath);
  // HTML を描画している間はソースを取得しない (プレビューは iframe が自分で取る)。画像も raw の <img> に任せる
  const showHtml = mode === "preview" && isHtmlPath(activePath);
  const showImage = mode === "preview" && isImageName(activePath);
  const skipFetch = showHtml || showImage;
  // ストレージ有効モードはブラウザから見たポートが分かってからだけ選べる (client にポートを焼き込まない)
  const storageEnabled = filePreviewPort !== undefined && previewOriginFor(origins, activePath) === "storage";
  const htmlPreviewSrc =
    filePreviewPort !== undefined && storageEnabled
      ? fileStoragePreviewUrl(fetchPath, filePreviewPort)
      : fileHtmlPreviewUrl(fetchPath);
  // 新しいタブはパス行の切替と関係なく常に別オリジンで開く (storage を使えるのが別タブを出す目的)。
  // ポート未取得の間だけ同一オリジンへ倒す
  const newTabSrc =
    filePreviewPort === undefined ? fileHtmlPreviewUrl(fetchPath) : fileStoragePreviewUrl(fetchPath, filePreviewPort);
  // ハイライトをタブごとに保持しない理由は docs/file-preview.md。
  const code = useMemo(
    () => (skipFetch || text === undefined ? null : buildPreviewCode(text, activePath)),
    [skipFetch, text, activePath],
  );
  const imageMeta = showImage
    ? imageMetaLabel(activeSize, loadedImage?.path === activePath ? loadedImage.dimensions : undefined)
    : null;

  // 表示中のタブがバーの外 (横スクロール) へ隠れないようにする
  useEffect(() => {
    activeTabRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activePath]);

  // 表示中のタブだけ取得する。取得中に切り替えたら中断して結果を捨てる (再表示で取り直す)
  useEffect(() => {
    if (skipFetch) return;
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
  }, [activePath, fetchPath, results, skipFetch]);

  useEffect(() => {
    setResults((prev) => dropClosedPreviews(prev, paths));
  }, [paths]);

  return (
    // 幅が足りないときはツリーの下 (border-t)、コンテナが @2xl 以上ならツリーの右 (border-l) へ置く
    <section
      aria-label="ファイルプレビュー"
      className="flex min-h-40 min-w-0 flex-1 flex-col border-t border-line @2xl:min-h-0 @2xl:border-t-0 @2xl:border-l"
    >
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
      {/* パス行 (パンくず / 切替 / メタ)。プレビューの上へ重ねると下の HTML の右上を隠して押せなくするため、
          行として本文の外に残す */}
      <div className="flex items-center gap-3 px-4 py-1.5">
        <FileBreadcrumb rootPath={rootPath} activePath={activePath} onReveal={onReveal} />
        {isHtmlPath(activePath) ? (
          <PreviewModeToggle mode={mode} onChange={(next) => onModeChange(activePath, next)} />
        ) : null}
        {showHtml ? (
          // 押すと iframe の src が変わってプレビューが開き直る。既定は ON (別オリジン) で、
          // ポート未取得の間は押せない (client にポートを焼き込まない)
          <ToggleSwitch
            size="sm"
            checked={storageEnabled}
            disabled={filePreviewPort === undefined}
            label="別オリジン"
            title={storageEnabled ? PREVIEW_ORIGIN_OFF_NOTE : PREVIEW_ORIGIN_ON_NOTE}
            onChange={(next) => onOriginChange(activePath, next ? "storage" : "app")}
          />
        ) : null}
        {code !== null && code.lineCount > 0 ? (
          <span className="shrink-0 text-3xs text-ink-ghost">
            {code.highlight?.lang ?? "text"} · {code.lineCount} 行
          </span>
        ) : null}
        {imageMeta === null ? null : <span className="shrink-0 text-3xs text-ink-ghost tabular-nums">{imageMeta}</span>}
        {code === null ? null : <FileCopyButton key={activePath} text={previewCopyText(code)} />}
        {/* プレビュー中だけ出す (ソース表示から開くと、見えている本文と違う描画結果が出る) */}
        {showHtml ? (
          <a
            href={newTabSrc}
            target="_blank"
            rel="noreferrer noopener"
            aria-label="新しいタブで開く"
            title="新しいタブで開く"
            className="grid size-6 shrink-0 place-items-center rounded-md text-ink-faint transition-colors hover:text-accent-text"
          >
            <ExternalLinkIcon />
          </a>
        ) : null}
      </div>
      {result?.error && !skipFetch ? (
        <p role="alert" className="px-4 py-2 text-xs break-words text-danger-text">
          {result.error}
        </p>
      ) : showImage ? (
        <div className="image-canvas min-h-0 flex-1 overflow-auto p-2">
          <img
            src={fileRawUrl(fetchPath, previewVersion)}
            alt={`${fetchPath} のプレビュー`}
            onLoad={(event) =>
              setLoadedImage({
                path: activePath,
                dimensions: { width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight },
              })
            }
            className="mx-auto max-h-full max-w-full object-contain"
          />
        </div>
      ) : showHtml ? (
        // 相対パスは同じルート配下 (画像 / テキストアセット) へ解決する。sandbox フラグは CSP と両方に書く。
        // Chromium はナビゲーション開始時の sandbox フラグで文書を作るため、src と sandbox を同じ更新で
        // 変えると古いフラグで読み込まれる (CSP 側では打ち消せない)。切替時は key を変えて要素ごと作り直す
        <iframe
          key={storageEnabled ? "storage" : "isolated"}
          src={htmlPreviewSrc}
          title={`${fetchPath} のプレビュー`}
          sandbox={storageEnabled ? "allow-scripts allow-same-origin allow-pointer-lock" : "allow-scripts"}
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
              {lineNumbers(code.lineCount)}
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

// 画面 root はツリーに対応する行がなく押せないため、パンくずへ出さない。
export function FileBreadcrumb({
  rootPath,
  activePath,
  onReveal,
}: {
  rootPath: string;
  activePath: string;
  onReveal: (path: string) => void;
}) {
  const crumbs = fileTreeBreadcrumbs(activePath);

  return (
    // 表示はこれまでと同じ全体パス (tooltip) を保ち、横幅が足りなければ横スクロールへ逃がす
    <nav
      aria-label="ファイルの場所"
      title={fileTreeFetchPath(rootPath, activePath)}
      className="min-w-0 flex-1 scrollbar-thin overflow-x-auto"
    >
      <ol className="flex items-center font-mono text-1xs text-ink-muted">
        {crumbs.map((crumb, index) => (
          <li key={crumb.path} className="flex shrink-0 items-center">
            {index > 0 ? (
              <span aria-hidden className="px-0.5 text-ink-ghost">
                /
              </span>
            ) : null}
            <button
              type="button"
              aria-current={crumb.path === activePath ? "page" : undefined}
              title={`${crumb.path} をツリーで表示`}
              onClick={() => onReveal(crumb.path)}
              className="rounded px-0.5 transition-colors outline-none hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-focus"
            >
              {crumb.label}
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}

function FileCopyButton({ text }: { text: string }) {
  const { copiedId, copyMessage } = useMessageCopy();
  return (
    <CopyButton copied={copiedId === "file"} onClick={() => void copyMessage(text, "file")} label="本文をコピー" />
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
  const closeOnMiddleClick = (event: MouseEvent<HTMLDivElement>) => {
    if (isMiddleClick(event)) onClose();
  };
  return (
    <div
      ref={rootRef}
      // 中クリック (PC のホイール押し込み) でも閉じる。既定動作は auxclick では止められないので、
      // down 側で止める (止めないと Windows のオートスクロール / Linux のペーストが同時に走る)
      onMouseDown={(event) => {
        if (isMiddleClick(event)) event.preventDefault();
      }}
      onAuxClick={closeOnMiddleClick}
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
