import { rename } from "node:fs/promises"

export type MovePathFailure = {
  name: string
  message: string
  status: 501
}

const CROSS_DEVICE_FAILURE: MovePathFailure = {
  name: "CrossDevice",
  message: "Cannot move across filesystems",
  status: 501,
}

function hasErrorCode(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === code
  )
}

/** Maps fs.rename errors to an API error, or null when the error should bubble up. */
export function mapMovePathError(err: unknown): MovePathFailure | null {
  if (hasErrorCode(err, "EXDEV")) {
    return CROSS_DEVICE_FAILURE
  }
  return null
}

/**
 * Moves a path with fs.rename.
 * Kept in its own module so the EXDEV mapping is unit-testable.
 */
export async function movePath(
  source: string,
  destination: string,
): Promise<void> {
  await rename(source, destination)
}
