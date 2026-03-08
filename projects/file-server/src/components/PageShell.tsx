import type { Child, FC } from "hono/jsx"
import type { UserState } from "../types"

interface PageShellProps {
  children: Child
  user?: UserState
}

const inlineFormErrorScript = `
  (() => {
    const formEndpoints = new Set(["/api/file", "/api/mkdir", "/api/rename"]);

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
        if (
          payload?.error?.name !== "AlreadyExists" ||
          typeof payload?.error?.message !== "string"
        ) {
          return;
        }
        showFormError(form, payload.error.message);
      } catch {
      }
    });
  })();
`

export const PageShell: FC<PageShellProps> = ({ children, user }) => {
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
        `}</style>
      </head>
      <body className="box-border min-h-screen bg-gradient-to-br from-indigo-50 via-purple-50 to-pink-50 font-sans">
        <div className="mx-auto max-w-7xl p-5">
          <div className="rounded-2xl border-2 border-indigo-200 bg-white/80 p-6 backdrop-blur-sm">
            <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <h1 className="bg-gradient-to-r from-indigo-600 to-purple-600 bg-clip-text text-3xl font-bold text-transparent">
                File Server
              </h1>
              {user?.type === "authenticated" && (
                <div className="flex items-center gap-2 text-sm">
                  <span className="rounded-md bg-indigo-50 px-2 py-1 font-medium text-indigo-700">
                    {user.username}
                  </span>
                  <span className="rounded-md bg-gray-100 px-2 py-1 font-medium text-gray-700">
                    {user.role}
                  </span>
                  <form action="/logout" method="post">
                    <button
                      type="submit"
                      className="rounded-md bg-gray-100 px-3 py-1.5 font-medium text-gray-700 hover:bg-gray-200"
                    >
                      Logout
                    </button>
                  </form>
                </div>
              )}
            </header>
            {user?.type === "authenticated" && (
              <p className="mb-4 text-sm text-gray-600">
                {user.role === "admin"
                  ? "Current / maps to the server upload root."
                  : `Current / maps to your private directory (${user.username}/).`}
              </p>
            )}
            <div
              id="notification-area"
              className="fixed top-5 right-5 z-50 max-w-md"
            ></div>
            <div id="main-content">
              <div id="file-list-container">{children}</div>
            </div>
          </div>
        </div>
        <div id="file-viewer-container"></div>
      </body>
    </html>
  )
}
