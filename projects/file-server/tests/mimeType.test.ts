import { describe, expect, it } from "bun:test"
import {
  lookupMimeType,
  normalizeResponseMimeType,
  resolveResponseMimeType,
} from "../src/utils/mimeType"

describe("lookupMimeType", () => {
  it("returns detected mime type for known extensions", () => {
    expect(lookupMimeType("index.html")).toBe("text/html")
  })

  it("falls back to application/octet-stream for unknown extensions", () => {
    expect(lookupMimeType("file.unknownext")).toBe("application/octet-stream")
  })
})

describe("normalizeResponseMimeType", () => {
  it("adds utf-8 charset to text/html", () => {
    expect(normalizeResponseMimeType("text/html")).toBe("text/html; charset=utf-8")
  })

  it("keeps an existing charset parameter", () => {
    expect(normalizeResponseMimeType("text/html; charset=iso-8859-1")).toBe(
      "text/html; charset=iso-8859-1",
    )
  })

  it("adds utf-8 charset to +json mime types", () => {
    expect(normalizeResponseMimeType("application/ld+json")).toBe(
      "application/ld+json; charset=utf-8",
    )
  })

  it("adds utf-8 charset to +xml mime types", () => {
    expect(normalizeResponseMimeType("application/atom+xml")).toBe(
      "application/atom+xml; charset=utf-8",
    )
  })

  it("does not add charset to binary mime types", () => {
    expect(normalizeResponseMimeType("image/png")).toBe("image/png")
  })
})

describe("resolveResponseMimeType", () => {
  it("resolves text/html with utf-8 charset from a file path", () => {
    expect(resolveResponseMimeType("page.html")).toBe("text/html; charset=utf-8")
  })

  it("resolves binary mime types without adding charset", () => {
    expect(resolveResponseMimeType("image.png")).toBe("image/png")
  })
})
