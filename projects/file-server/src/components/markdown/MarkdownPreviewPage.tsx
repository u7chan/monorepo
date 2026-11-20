import type { FC } from "hono/jsx"
import { MARKDOWN_MAX_LENGTH, parseMarkdown } from "../../utils/markdown/parse"
import { MarkdownView } from "./MarkdownView"

/**
 * 新しいタブで開く Markdown プレビュー。
 *
 * Why not reuse PageShell: プレビューはアプリの操作 UI ではなく文書なので、
 * HTMX も Tailwind CDN も読み込まない自己完結したページにする。CSP で
 * スクリプトを禁止したまま、文書の見た目だけをここで完結させる。
 */
const previewStyles = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: #ffffff;
    color: #0f172a;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", "Hiragino Sans", "Noto Sans JP", sans-serif;
    font-size: 16px;
    line-height: 1.75;
    -webkit-text-size-adjust: 100%;
  }
  .markdown-body {
    max-width: 52rem;
    margin: 0 auto;
    padding: 3rem 1.5rem 5rem;
    overflow-wrap: anywhere;
  }
  .markdown-body > :first-child { margin-top: 0; }
  h1, h2, h3, h4, h5, h6 {
    margin: 2em 0 0.75em;
    font-weight: 600;
    line-height: 1.35;
  }
  h1 { font-size: 1.75rem; }
  h2 { padding-bottom: 0.35em; border-bottom: 1px solid #e2e8f0; font-size: 1.375rem; }
  h3 { font-size: 1.125rem; }
  h4, h5, h6 { font-size: 1rem; }
  h5, h6 { color: #475569; }
  p, ul, ol, blockquote, pre, .md-table-wrap { margin: 0 0 1em; }
  ul, ol { padding-left: 1.5em; }
  li { margin: 0.25em 0; }
  li > ul, li > ol { margin: 0.25em 0 0; }
  .md-task-item { list-style: none; }
  .md-task-item input {
    margin: 0 0.5em 0 0;
    accent-color: #4f46e5;
    vertical-align: -0.1em;
  }
  a { color: #4f46e5; text-decoration: underline; text-underline-offset: 0.15em; }
  a:hover { color: #4338ca; }
  code, pre {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
    font-size: 0.875em;
  }
  code {
    padding: 0.15em 0.35em;
    border-radius: 0.25rem;
    background: #f1f5f9;
  }
  pre {
    padding: 1rem;
    overflow-x: auto;
    border: 1px solid #e2e8f0;
    border-radius: 0.5rem;
    background: #f8fafc;
    line-height: 1.6;
  }
  pre code {
    padding: 0;
    background: transparent;
    font-size: 1em;
  }
  blockquote {
    padding: 0.25em 0 0.25em 1em;
    border-left: 3px solid #cbd5e1;
    color: #475569;
  }
  blockquote > :last-child { margin-bottom: 0; }
  img {
    max-width: 100%;
    height: auto;
    border-radius: 0.5rem;
    vertical-align: middle;
  }
  .md-table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; }
  th, td {
    padding: 0.5rem 0.75rem;
    border: 1px solid #e2e8f0;
    text-align: left;
    vertical-align: top;
    /* 表のセルは単語の途中で折らない (列幅は中身に合わせ、広い表は横スクロール) */
    overflow-wrap: break-word;
  }
  thead th { background: #f8fafc; font-weight: 600; }
  .md-align-center { text-align: center; }
  .md-align-right { text-align: right; }
  hr { margin: 2rem 0; border: 0; border-top: 1px solid #e2e8f0; }
  .md-literal {
    padding: 0.1em 0.3em;
    border-radius: 0.25rem;
    background: #f1f5f9;
    color: #64748b;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
    font-size: 0.875em;
  }
  .md-notice { color: #64748b; }
  .md-plain { white-space: pre-wrap; }
  @media (max-width: 40rem) {
    .markdown-body { padding: 2rem 1rem 3.5rem; }
    h1 { font-size: 1.5rem; }
  }
`

export interface MarkdownPreviewPageProps {
  fileName: string
  content: string
}

export const MarkdownPreviewPage: FC<MarkdownPreviewPageProps> = ({
  fileName,
  content,
}) => {
  const isTooLarge = content.length > MARKDOWN_MAX_LENGTH
  const isEmpty = content.trim() === ""

  return (
    <html lang="ja">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>{fileName}</title>
        {/* 固定の文字列だけを埋め込む。JSX のテキストとして渡すと `<` や `&` が
            エスケープされ、生テキスト要素の <style> では CSS が壊れる */}
        <style dangerouslySetInnerHTML={{ __html: previewStyles }} />
      </head>
      <body>
        <article className="markdown-body">
          {isEmpty ? (
            <p className="md-notice">This file is empty.</p>
          ) : isTooLarge ? (
            <>
              <p className="md-notice">
                This file is too large to render as Markdown. Showing the source
                instead.
              </p>
              <pre className="md-plain">{content}</pre>
            </>
          ) : (
            <MarkdownView blocks={parseMarkdown(content)} />
          )}
        </article>
      </body>
    </html>
  )
}
