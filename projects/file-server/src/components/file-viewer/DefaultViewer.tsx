import type { FC } from "hono/jsx"
import { secondaryButtonClassName } from "../buttonStyles"

interface DefaultViewerProps {
  path?: string
}

export const DefaultViewer: FC<DefaultViewerProps> = ({ path }) => {
  const encodedPath = path ? encodeURIComponent(path) : ""

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-5 overflow-auto rounded-lg bg-slate-50 p-8 text-center">
      <p className="text-sm text-slate-500">
        This file type cannot be displayed in the browser.
      </p>
      {path ? (
        <button
          type="button"
          hx-get={`/file?path=${encodedPath}&view=text`}
          hx-target="#file-viewer-container"
          hx-swap="outerHTML"
          className={secondaryButtonClassName}
        >
          Open as text
        </button>
      ) : null}
    </div>
  )
}
