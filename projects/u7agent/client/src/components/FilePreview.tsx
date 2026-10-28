import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type Ref,
  type RefObject,
} from "react";
import { fileHtmlPreviewUrl, fileRawUrl, fileStoragePreviewUrl, getFilePreview } from "../api";
import { useExitPhase } from "../hooks/useExitPhase";
import { useMessageCopy } from "../hooks/useMessageCopy";
import { isAudioName, isImageName } from "../lib/attachments";
import { cn } from "../lib/cn";
import { lineNumbers } from "../lib/codeLines";
import { selectCopyTarget } from "../lib/copyToClipboard";
import { buildPreviewCode, isHtmlPath, isMarkdownPath, previewCopyText } from "../lib/fileCode";
import { filePreviewErrorHint } from "../lib/filePreviewError";
import {
  FILE_PREVIEW_FULLSCREEN_CLOSE_LABEL,
  FILE_PREVIEW_FULLSCREEN_OPEN_LABEL,
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
import { fileTreeBreadcrumbs, fileTreeFetchPath, fileTreeParentPath } from "../lib/fileTree";
import { imageMetaLabel, type ImageDimensions } from "../lib/imageMeta";
import { LoadingMark } from "./LoadingMark";
import { SegmentedControl } from "./SegmentedControl";
import { MarkdownFilePreview } from "./markdown/MarkdownFilePreview";
import { ToggleSwitch } from "./ToggleSwitch";
import { CopyButton } from "./chat/CopyButton";
import { CloseIcon, CollapseIcon, ExpandIcon, ExternalLinkIcon } from "./icons";

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
  // 全画面の読み面。狭い面ではツリーと分け合ってプレビューが数十行しか見えないため、同じ面を dialog へ移す
  // (複製すると HTML の iframe が 2 枚になる)。閉じたらボタンへ焦点を戻す
  const [fullscreen, setFullscreen] = useState(false);
  const fullscreenDialogRef = useRef<HTMLDialogElement>(null);
  const fullscreenButtonRef = useRef<HTMLButtonElement>(null);
  const restoreFullscreenFocus = useRef(false);
  // 退場アニメの間は dialog を開いたままにする (閉じ切ってから close() する)
  const fullscreenPhase = useExitPhase(fullscreen, fullscreenDialogRef);
  const fullscreenVisible = fullscreen || fullscreenPhase === "closing";
  // 開閉は native の showModal / close だけで行う (面を portal / 条件分岐で移すと React が要素を作り直し、
  // iframe が文書を取り直してスクロール・入力・JS の状態が消える)。close を layout effect に置くのは、
  // 退場アニメの終了と同じ描画で閉じるため (passive だと 1 フレーム「open のまま閉状態の寸法」が出る)
  useLayoutEffect(() => {
    const dialog = fullscreenDialogRef.current;
    if (dialog === null) return;
    if (fullscreen && !dialog.open) {
      dialog.showModal();
      // 開いたときに先頭のボタンへ勝手に当てない (実機で意図しない操作へフォーカスが飛ぶ)
      dialog.focus();
    } else if (!fullscreen && fullscreenPhase === "closed" && dialog.open) {
      dialog.close();
    }
  }, [fullscreen, fullscreenPhase]);
  useEffect(() => {
    if (fullscreenVisible || !restoreFullscreenFocus.current) return;
    restoreFullscreenFocus.current = false;
    fullscreenButtonRef.current?.focus();
  }, [fullscreenVisible]);
  const closeFullscreen = () => {
    restoreFullscreenFocus.current = true;
    setFullscreen(false);
  };
  // 読み込みが終わった画像の寸法。パスを一緒に持ち、タブを切り替えたら前のタブの値を出さない
  const [loadedImage, setLoadedImage] = useState<{ path: string; dimensions: ImageDimensions } | null>(null);
  const activeTabRef = useRef<HTMLDivElement | null>(null);
  // コピーに失敗したとき、表示中の本文を選択状態にする導線の対象 (本文はヘッダとは別の枝に出る)
  const codeBodyRef = useRef<HTMLDivElement | null>(null);
  const labels = fileTabLabels(paths);
  const fetchPath = fileTreeFetchPath(rootPath, activePath);
  const result = readPreview(results, activePath);
  const errorHint = result?.error ? filePreviewErrorHint(result.error, fetchPath) : undefined;
  const text = result?.text;
  const mode = previewModeFor(modes, activePath);
  // HTML を描画している間はソースを取得しない (プレビューは iframe が自分で取る)。画像 / 音声も raw の
  // <img> / <audio> に任せる。Markdown は描画側が本文を使うため、プレビューでも取得する (HTML / 画像 / 音声とはここが違う)
  const showHtml = mode === "preview" && isHtmlPath(activePath);
  const showImage = mode === "preview" && isImageName(activePath);
  const showAudio = mode === "preview" && isAudioName(activePath);
  const showMarkdown = mode === "preview" && isMarkdownPath(activePath);
  const skipFetch = showHtml || showImage || showAudio;
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
  // Markdown のプレビューは本文をそのまま描くため、ソース用の変換 (ハイライト) は走らせない
  const code = useMemo(
    () => (skipFetch || showMarkdown || text === undefined ? null : buildPreviewCode(text, activePath)),
    [skipFetch, showMarkdown, text, activePath],
  );
  // プレビューの相対画像は、表示中のファイルと同じディレクトリを基準にする (fetchPath の親)
  const markdownDir = fileTreeParentPath(fetchPath);
  const markdownRawUrl = useCallback((path: string) => fileRawUrl(path, previewVersion), [previewVersion]);
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

  const preview = (
    // 幅が足りないときはツリーの下 (border-t)、コンテナが @2xl 以上ならツリーの右 (border-l) へ置く
    <section
      aria-label="ファイルプレビュー"
      // 全画面 (退場アニメの間を含む) では @2xl を当てない: dialog をその場に置くと祖先の @container が
      // 一致するようになり、portal で作っていたときは付かなかった境界線が全画面の左上へ出る
      className={cn(
        "flex min-h-40 min-w-0 flex-1 flex-col border-t border-line",
        !fullscreenVisible && "@2xl:min-h-0 @2xl:border-t-0 @2xl:border-l",
      )}
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
        {isHtmlPath(activePath) || isMarkdownPath(activePath) ? (
          <SegmentedControl
            items={PREVIEW_MODES}
            value={mode}
            onChange={(next) => onModeChange(activePath, next)}
            ariaLabel="表示の切替"
          />
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
        {code === null ? null : (
          <FileCopyButton key={activePath} text={previewCopyText(code)} targetRef={codeBodyRef} />
        )}
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
        <button
          type="button"
          ref={fullscreenButtonRef}
          aria-label={fullscreenVisible ? FILE_PREVIEW_FULLSCREEN_CLOSE_LABEL : FILE_PREVIEW_FULLSCREEN_OPEN_LABEL}
          title={fullscreenVisible ? FILE_PREVIEW_FULLSCREEN_CLOSE_LABEL : FILE_PREVIEW_FULLSCREEN_OPEN_LABEL}
          onClick={() => {
            // 退場アニメの間の押下は受けない (開き直すとアニメの途中で面が戻る)
            if (fullscreenPhase === "closing") return;
            if (fullscreen) closeFullscreen();
            else setFullscreen(true);
          }}
          className="grid size-6 shrink-0 place-items-center rounded-md text-ink-faint transition-colors hover:text-accent-text"
        >
          {fullscreenVisible ? <CollapseIcon /> : <ExpandIcon />}
        </button>
      </div>
      {result?.error && !skipFetch ? (
        <p role="alert" className="px-4 py-2 text-xs break-words text-danger-text">
          {result.error}
          {errorHint ? <span> {errorHint}</span> : null}
        </p>
      ) : showImage ? (
        // 縦も中央に置く (items-center)。はみ出した分が上で切れるのは枠の高さが未確定のときなので、
        // flex-1 + min-h-0 で高さが確定するここでは max-h-full が効き、画像は枠に収まる
        <div className="image-canvas flex min-h-0 flex-1 items-center justify-center overflow-auto p-2">
          <img
            src={fileRawUrl(fetchPath, previewVersion)}
            alt={`${fetchPath} のプレビュー`}
            onLoad={(event) =>
              setLoadedImage({
                path: activePath,
                dimensions: { width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight },
              })
            }
            className="max-h-full max-w-full object-contain"
          />
        </div>
      ) : showAudio ? (
        // 再生とシークはブラウザの操作に任せ、再生位置は保存しない。src は画像と同じ版付きの raw URL
        <div className="min-h-0 flex-1 overflow-auto p-4">
          <audio
            controls
            src={fileRawUrl(fetchPath, previewVersion)}
            aria-label={`${fetchPath} のプレビュー`}
            className="w-full"
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
      ) : showMarkdown ? (
        text === undefined ? (
          <p className="flex px-4 py-2">
            <LoadingMark />
          </p>
        ) : text === "" ? (
          <p className="px-4 py-2 text-xs text-ink-muted">（空のファイル）</p>
        ) : (
          <MarkdownFilePreview text={text} dir={markdownDir} rawUrl={markdownRawUrl} />
        )
      ) : code === null ? (
        <p className="flex px-4 py-2">
          <LoadingMark />
        </p>
      ) : code.lineCount === 0 ? (
        <p className="px-4 py-2 text-xs text-ink-muted">（空のファイル）</p>
      ) : (
        // 行番号は本文と別の列にする。番号は行ごとの要素ではなく 1 つのテキストノードで出す
        <div ref={codeBodyRef} tabIndex={0} className="file-code min-h-0 flex-1 scrollbar-thin font-mono">
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

  // dialog は常に同じ位置に置く (閉じている間は `display: contents` で box を作らない)。条件分岐や portal で
  // 面を移すと React が要素を作り直し、HTML プレビューの iframe が文書を取り直してしまう
  return (
    <dialog
      ref={fullscreenDialogRef}
      // 閉じている間は dialog を名乗らない (通常のブロックとして置く外装なので、読み上げの区切りにしない)。
      // 焦点可能な要素 (tabIndex) が残っていると ARIA は presentation を無視するため、開いている間だけ付ける
      role={fullscreenVisible ? undefined : "presentation"}
      aria-label={fullscreenVisible ? "ファイルプレビュー" : undefined}
      tabIndex={fullscreenVisible ? -1 : undefined}
      data-closing={fullscreenPhase === "closing"}
      // 自分の close だけを祖先の dialog へ渡さない: React の合成イベントは子孫から祖先の dialog まで伝わるため、
      // 狭い幅のシート (外側 modal) の中ではシートまで同時に閉じる。子孫 (画像の拡大) の close は握り潰さない
      onClose={(event) => {
        if (event.target === event.currentTarget) event.stopPropagation();
      }}
      // Escape は標準の cancel。既定の close は瞬時なので止め、退場アニメを挟んでから閉じる。子孫の cancel
      // (本文の画像の拡大 = portal の dialog) も React のツリーを伝わって届くので、自分の分だけを受ける
      // (受けると拡大の標準の close を preventDefault で打ち消し、Escape で拡大が閉じなくなる)
      onCancel={(event) => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        event.stopPropagation();
        closeFullscreen();
      }}
      // 閉じている間は止めない (常に止めると、インライン表示のまま設定ページの Escape = 一覧へ戻る /
      // チャットへ戻るまで届かなくなる)
      onKeyDown={(event) => {
        if (event.key === "Escape" && event.currentTarget.open) event.stopPropagation();
      }}
      // h-dvh + 余白なし: プレビュー本体が viewport の高さいっぱいを使う。閉じている間に当てると
      // 閉状態が全画面になるため、開いている間だけ当てる
      className={cn(
        "file-preview-dialog viewer-dialog",
        fullscreenVisible &&
          "m-0 flex h-dvh max-h-none w-screen max-w-none flex-col border-0 bg-panel p-0 focus:outline-none",
      )}
    >
      {preview}
    </dialog>
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

function FileCopyButton({ text, targetRef }: { text: string; targetRef: RefObject<HTMLElement | null> }) {
  const { copiedId, copyMessage, copyFailure } = useMessageCopy();
  return (
    <CopyButton
      copied={copiedId === "file"}
      failure={copyFailure("file")}
      onClick={() => void copyMessage(text, "file")}
      onSelect={() => selectCopyTarget(targetRef.current)}
      label="本文をコピー"
    />
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
