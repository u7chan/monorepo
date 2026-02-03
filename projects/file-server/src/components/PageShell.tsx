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
        <style>{`
          * { box-sizing: border-box; }
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            max-width: 1200px;
            margin: 0 auto;
            padding: 20px;
            background: #f5f5f5;
          }
          .container {
            background: white;
            padding: 20px;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
          }
          nav { margin-bottom: 1em; }
          nav a { color: #0066cc; text-decoration: none; margin: 0 0.2em; }
          nav a:hover { text-decoration: underline; }
          ul { list-style: none; padding: 0; }
          li {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 0.5em;
            border-bottom: 1px solid #eee;
          }
          li:hover { background: #f9f9f9; }
          .file-actions {
            display: flex;
            gap: 1em;
            align-items: center;
          }
          .file-size { width: 120px; text-align: right; }
          .file-mtime { width: 180px; text-align: right; color: #666; font-size: 0.9em; }
          form { margin: 1em 0; }
          input[type="text"], input[type="file"] {
            padding: 0.5em;
            border: 1px solid #ddd;
            border-radius: 4px;
            margin-right: 0.5em;
          }
          button {
            padding: 0.5em 1em;
            background: #0066cc;
            color: white;
            border: none;
            border-radius: 4px;
            cursor: pointer;
          }
          button:hover { background: #0052a3; }
          button[type="submit"] { font-size: 0.9em; }
          .delete-btn { background: #cc3333; }
          .delete-btn:hover { background: #a32929; }
          pre {
            background: #f4f4f4;
            padding: 1em;
            border-radius: 4px;
            overflow-x: auto;
            white-space: pre-wrap;
            word-wrap: break-word;
          }
          .viewer-container {
            margin-top: 1em;
          }
          .viewer-container img, .viewer-container video {
            max-width: 100%;
            border-radius: 4px;
          }
          .error-message {
            background: #ffebee;
            color: #c62828;
            padding: 1em;
            border-radius: 4px;
            margin: 1em 0;
            border-left: 4px solid #c62828;
          }
          .success-message {
            background: #e8f5e9;
            color: #2e7d32;
            padding: 1em;
            border-radius: 4px;
            margin: 1em 0;
            border-left: 4px solid #2e7d32;
          }
          #notification-area {
            position: fixed;
            top: 20px;
            right: 20px;
            max-width: 400px;
            z-index: 1000;
          }
          .notification {
            padding: 1em;
            margin-bottom: 0.5em;
            border-radius: 4px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.2);
            animation: slideIn 0.3s ease-out;
          }
          @keyframes slideIn {
            from { transform: translateX(100%); opacity: 0; }
            to { transform: translateX(0); opacity: 1; }
          }
          .htmx-indicator {
            display: none;
            opacity: 0.5;
          }
          .htmx-request .htmx-indicator {
            display: inline;
          }
          .htmx-request.htmx-indicator {
            display: inline;
          }
        `}</style>
      </head>
      <body>
        <div class="container">
          <h1>File Server</h1>
          <div id="notification-area"></div>
          <div id="main-content">{children}</div>
        </div>
      </body>
    </html>
  )
}
