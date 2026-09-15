import type { Child, FC } from "hono/jsx"
import type { UserState } from "../types"
import { dismissButtonClassName } from "./buttonStyles"
import { badgeClassName } from "./uiStyles"

interface PageShellProps {
  children: Child
  user?: UserState
}

const inlineFormErrorScript = `
  (() => {
    const formEndpoints = new Set(["/api/file", "/api/mkdir", "/api/rename", "/api/move"]);

    const getForm = (detail) => {
      const source = detail?.elt instanceof Element ? detail.elt : null;
      if (!source) {
        return null;
      }
      return source.closest("form");
    };

    const getErrorNode = (form) => form?.querySelector("[data-form-error]") ?? null;

    const clearFormError = (form) => {
      const errorNode = getErrorNode(form);
      if (!errorNode) {
        return;
      }
      errorNode.textContent = "";
      errorNode.classList.add("hidden");
    };

    const showFormError = (form, message) => {
      const errorNode = getErrorNode(form);
      if (!errorNode) {
        return;
      }
      errorNode.textContent = message;
      errorNode.classList.remove("hidden");
    };

    document.addEventListener("input", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      const form = target.closest("form[data-inline-error-form]");
      if (form) {
        clearFormError(form);
      }
    });

    document.addEventListener("htmx:beforeRequest", (event) => {
      const form = getForm(event.detail);
      if (form?.matches("[data-inline-error-form]")) {
        clearFormError(form);
      }
    });

    document.addEventListener("htmx:afterRequest", (event) => {
      const form = getForm(event.detail);
      if (!form?.matches("[data-move-form]")) {
        return;
      }
      if (!event.detail?.successful) {
        return;
      }
      const picker = document.getElementById("move-picker-container");
      if (picker) {
        picker.innerHTML = "";
      }
    });

    document.addEventListener("htmx:responseError", (event) => {
      const form = getForm(event.detail);
      if (!form?.matches("[data-inline-error-form]")) {
        return;
      }

      const xhr = event.detail?.xhr;
      if (!xhr || xhr.status !== 400) {
        return;
      }

      const action =
        form.getAttribute("hx-post") || form.getAttribute("action") || "";
      if (!formEndpoints.has(action)) {
        return;
      }

      try {
        const payload = JSON.parse(xhr.responseText);
        if (typeof payload?.error?.message !== "string") {
          return;
        }
        showFormError(form, payload.error.message);
      } catch {
      }
    });
  })();
`

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
        <style>{`
          .image-viewer-img {
            height: -webkit-fill-available;
            height: -moz-available;
            height: stretch;
          }

          .pdf-viewer-shell {
            min-height: 0;
          }

          .pdf-viewer-frame {
            display: block;
            min-height: min(72vh, 56rem);
          }

          @keyframes modal-enter {
            from {
              opacity: 0;
              transform: translateY(4px) scale(0.99);
            }
            to {
              opacity: 1;
              transform: none;
            }
          }

          .modal-enter {
            animation: modal-enter 0.15s ease-out;
          }

          @media (prefers-reduced-motion: reduce) {
            .modal-enter {
              animation: none;
            }
          }
        `}</style>
      </head>
      <body className="box-border flex h-dvh flex-col overflow-hidden bg-slate-50 font-sans text-slate-900 antialiased">
        <div className="mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col px-5 py-4">
          <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-3">
            <h1 className="text-xl font-semibold tracking-tight text-slate-900">
              File Server
            </h1>
            {isAuthenticated && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-slate-700">
                  {user.username}
                </span>
                {user.role === "admin" && (
                  <span className={badgeClassName}>{user.role}</span>
                )}
                {user.role === "admin" && (
                  <a href="/admin/users" className={dismissButtonClassName}>
                    User Management
                  </a>
                )}
                <form action="/logout" method="post">
                  <button type="submit" className={dismissButtonClassName}>
                    Logout
                  </button>
                </form>
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
          {/* The scroll container clips at its padding edge, so it carries a
              small inline bleed (`-mx-1 px-1`): without it the hairline rings
              and focus rings of items flush with the content edge (the file
              list surface, the first toolbar button) lose their outer pixel. */}
          <div
            id="main-content"
            className="-mx-1 flex min-h-0 flex-1 flex-col overflow-y-auto px-1 pt-3"
          >
            <div
              id="file-list-container"
              className="flex min-h-0 flex-1 flex-col"
            >
              {children}
            </div>
          </div>
        </div>
        <div id="file-viewer-container"></div>
        <div id="move-picker-container"></div>
      </body>
    </html>
  )
}
