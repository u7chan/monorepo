import { describe, expect, it } from "bun:test"
import { mapMovePathError } from "../src/utils/fsMove"

function withCode(code: string): NodeJS.ErrnoException {
  const err = new Error(code) as NodeJS.ErrnoException
  err.code = code
  return err
}

describe("mapMovePathError", () => {
  it("maps EXDEV to CrossDevice 501", () => {
    expect(mapMovePathError(withCode("EXDEV"))).toEqual({
      name: "CrossDevice",
      message: "Cannot move across filesystems",
      status: 501,
    })
  })

  it("returns null for other filesystem errors", () => {
    expect(mapMovePathError(withCode("EACCES"))).toBeNull()
    expect(mapMovePathError(withCode("ENOENT"))).toBeNull()
    expect(mapMovePathError(new Error("boom"))).toBeNull()
    expect(mapMovePathError(null)).toBeNull()
  })
})
