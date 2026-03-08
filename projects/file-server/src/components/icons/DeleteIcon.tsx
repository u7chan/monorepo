import type { FC } from "hono/jsx"

export const DeleteIcon: FC = () => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    className="h-[18px] w-[18px] shrink-0 text-white"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <title>Delete</title>
    <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
  </svg>
)
