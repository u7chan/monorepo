import type { Child, FC } from "hono/jsx"
import type { UserState } from "../types"
import { compactSecondaryButtonClassName } from "./buttonStyles"
import { inlineFormErrorScript } from "./pageShellScripts"
import { pageShellStyles } from "./pageShellStyles"
import { badgeClassName, verticalDividerClassName } from "./uiStyles"

interface PageShellProps {
  children: Child
  user?: UserState
}

export const PageShell: FC<PageShellProps> = ({ children, user }) => {
  const isAuthenticated = user?.type === "authenticated"

  return (
    <html lang="ja">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>File Server</title>
        <script src="https://cdn.jsdelivr.net/npm/htmx.org@2.0.8/dist/htmx.min.js"></script>
        <script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>
        <script dangerouslySetInnerHTML={{ __html: inlineFormErrorScript }} />
        <style>{pageShellStyles}</style>
      </head>
      <body className="box-border flex h-dvh flex-col overflow-hidden bg-slate-50 font-sans text-slate-900 antialiased">
        <div className="mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col px-5 py-4">
          <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-3">
            <h1 className="text-xl font-semibold tracking-tight text-slate-900">
              File Server
            </h1>
            {isAuthenticated && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <span className="flex items-center gap-2">
                  <span className="text-sm font-medium text-slate-700">
                    {user.username}
                  </span>
                  {user.role === "admin" && (
                    <span className={badgeClassName}>{user.role}</span>
                  )}
                </span>
                {/* The identity above is a label, the controls below are
                    buttons: a hairline keeps the two groups apart. Hide it
                    below `sm`: at narrow widths the header wraps and a
                    standalone hairline is left dangling at the end of the
                    line. */}
                <span
                  aria-hidden="true"
                  className={`${verticalDividerClassName} hidden sm:block`}
                />
                <div className="flex flex-wrap items-center gap-2">
                  {user.role === "admin" && (
                    <a
                      href="/admin/users"
                      className={compactSecondaryButtonClassName}
                    >
                      User Management
                    </a>
                  )}
                  <form action="/logout" method="post">
                    <button
                      type="submit"
                      className={compactSecondaryButtonClassName}
                    >
                      Logout
                    </button>
                  </form>
                </div>
              </div>
            )}
          </header>
          {isAuthenticated && (
            <p className="shrink-0 pt-3 text-sm text-slate-500">
              {user.role === "admin"
                ? "Current / shows the top-level public and private scopes."
                : "Current / is your home. Shared public files are shown as a shortcut."}
            </p>
          )}
          <div
            id="notification-area"
            className="fixed top-4 right-4 z-50 max-w-md"
          ></div>
          {/* The scroll container clips at its padding edge, so it bleeds on
              the inline sides and at the block end (`-mx-1 px-1 pb-1 -mb-1`):
              without it the hairline rings and focus rings of items flush with
              the content edge (the file list surface, the toolbar buttons)
              lose their outer pixel there. The block start needs no bleed
              because `pt-3` already exceeds the 4px a ring can occupy, and the
              negative margins give back exactly what the padding takes so the
              content column and the flex height stay put. */}
          <div
            id="main-content"
            className="-mx-1 -mb-1 flex min-h-0 flex-1 flex-col overflow-y-auto px-1 pt-3 pb-1"
          >
            {/* No id here: `#file-list-container` belongs to the FileList
                partial root, so pages without a list (/login, /admin/users)
                do not expose it. */}
            <div className="flex min-h-0 flex-1 flex-col">{children}</div>
          </div>
        </div>
        <div id="file-viewer-container"></div>
        <div id="move-picker-container"></div>
      </body>
    </html>
  )
}
