import type { Child, FC } from "hono/jsx"

interface PageShellProps {
  children: Child
}

export const PageShell: FC<PageShellProps> = ({ children }) => {
  return (
    <html lang="ja">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>File Server</title>
        <script src="https://cdn.jsdelivr.net/npm/htmx.org@2.0.8/dist/htmx.min.js"></script>
        <script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>
      </head>
      <body class="box-border font-sans max-w-7xl mx-auto p-5 bg-gradient-to-br from-indigo-50 via-purple-50 to-pink-50">
        <div class="bg-white/80 backdrop-blur-sm p-6 rounded-2xl border-2 border-indigo-200">
          <h1 class="text-3xl font-bold mb-4 bg-gradient-to-r from-indigo-600 to-purple-600 bg-clip-text text-transparent">File Server</h1>
          <div
            id="notification-area"
            class="fixed top-5 right-5 max-w-md z-50"
          ></div>
          <div id="main-content">
            <div id="file-list-container">{children}</div>
            <div id="file-viewer-container"></div>
          </div>
        </div>
      </body>
    </html>
  )
}
