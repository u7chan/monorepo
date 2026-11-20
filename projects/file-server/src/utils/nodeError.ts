/**
 * Node fs errors carry their reason in `code` (ENOENT, EEXIST, EXDEV, ...).
 * Callers have to narrow `unknown` before reading it, so keep the narrowing in
 * one place instead of repeating the property check at every catch site.
 */
export function isNodeErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === code
  )
}
