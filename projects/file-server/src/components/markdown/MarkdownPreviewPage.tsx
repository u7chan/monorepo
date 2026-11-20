import { raw } from "hono/html"
import type { FC } from "hono/jsx"
import { MARKDOWN_MAX_LENGTH, parseMarkdown } from "../../utils/markdown/parse"
import { MarkdownView } from "./MarkdownView"
import { markdownPreviewStyles } from "./previewStyles"

export interface MarkdownPreviewPageProps {
  fileName: string
  content: string
}

/**
 * 新しいタブで開く Markdown プレビュー。
 *
 * Why not reuse PageShell: プレビューはアプリの操作 UI ではなく文書なので、
 * HTMX も Tailwind CDN も読み込まない自己完結したページにする。CSP で
 * スクリプトを禁止したまま、文書の見た目だけをここで完結させる。
 */
export const MarkdownPreviewPage: FC<MarkdownPreviewPageProps> = ({
  fileName,
  content,
}) => {
  const isTooLarge = content.length > MARKDOWN_MAX_LENGTH
  const isEmpty = content.trim() === ""

  return (
    <>
      {/* Why here: quirks mode を避けるため、文書は doctype から始める */}
      {raw("<!doctype html>")}
      <html lang="ja">
        <head>
          <meta charset="UTF-8" />
          <meta
            name="viewport"
            content="width=device-width, initial-scale=1.0"
          />
          <title>{fileName}</title>
          {/* 固定の文字列だけを埋め込む。JSX のテキストとして渡すと `<` や `&` が
            エスケープされ、生テキスト要素の <style> では CSS が壊れる */}
          <style dangerouslySetInnerHTML={{ __html: markdownPreviewStyles }} />
        </head>
        <body>
          <article className="markdown-body">
            {isEmpty ? (
              <p className="md-notice">This file is empty.</p>
            ) : isTooLarge ? (
              <>
                <p className="md-notice">
                  This file is too large to render as Markdown. Showing the
                  source instead.
                </p>
                <pre className="md-plain">{content}</pre>
              </>
            ) : (
              <MarkdownView blocks={parseMarkdown(content)} />
            )}
          </article>
        </body>
      </html>
    </>
  )
}
