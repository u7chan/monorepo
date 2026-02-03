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
      <body class="box-border font-sans max-w-7xl mx-auto p-5 bg-gray-50">
        <div class="bg-white p-5 rounded-lg shadow-sm">
          <h1 class="text-2xl font-bold mb-4">File Server</h1>
          <div
            id="notification-area"
            class="fixed top-5 right-5 max-w-md z-50"
          ></div>
          <div id="main-content">{children}</div>
        </div>
      </body>
    </html>
  )
}
