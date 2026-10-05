import { MarkdownFileImageProvider } from "./MarkdownImageRefs";
import { MarkdownView } from "./MarkdownView";

export type MarkdownFilePreviewProps = {
  /** 表示中のファイルの本文 (取得した生のテキスト) */
  text: string;
  /** 表示中のファイルのディレクトリ (ワークスペース root 相対)。相対画像の解決基準 */
  dir: string;
  /** 解決した root 相対パスから raw URL を組み立てる (版付き)。呼び出し側が注入する */
  rawUrl: (rootRelativePath: string) => string;
};

/**
 * ファイルプレビューの Markdown 描画。チャット本文と同じ `MarkdownView` を使い、画像の解決だけを
 * 表示中のファイルのディレクトリ基準へ差し替える。本文は読み幅に収め、広い面では中央に寄せる。
 */
export function MarkdownFilePreview({ text, dir, rawUrl }: MarkdownFilePreviewProps) {
  return (
    <div className="min-h-0 flex-1 scrollbar-thin overflow-auto px-4 py-3">
      <div className="mx-auto w-full max-w-220">
        <MarkdownFileImageProvider dir={dir} rawUrl={rawUrl}>
          <MarkdownView text={text} />
        </MarkdownFileImageProvider>
      </div>
    </div>
  );
}
