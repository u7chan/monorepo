import type { FC } from "hono/jsx"

export const DefaultViewer: FC = () => {
  return (
    <div className="flex-1 overflow-auto flex justify-center items-center">
      <p className="mb-6 text-gray-600 text-lg text-center">
        This file type cannot be displayed in the browser.
      </p>
    </div>
  )
}
