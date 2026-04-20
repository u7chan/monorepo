import type { FC } from "hono/jsx"

export const MoveIcon: FC = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    aria-hidden="true"
  >
    <title>Move</title>
    <path d="M5 9l-3 3 3 3" />
    <path d="M19 9l3 3-3 3" />
    <path d="M9 5l3-3 3 3" />
    <path d="M9 19l3 3 3-3" />
    <path d="M2 12h20" />
    <path d="M12 2v20" />
  </svg>
)
