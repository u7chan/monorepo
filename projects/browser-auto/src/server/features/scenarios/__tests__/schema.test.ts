import { describe, expect, it } from "bun:test"
import { siteDefinitionSchema, scenarioDefinitionSchema, stepSchema } from "../schema"

describe("siteDefinitionSchema", () => {
  describe("valid", () => {
    it("accepts a complete site", () => {
      const result = siteDefinitionSchema.safeParse({
        schemaVersion: 1,
        id: "test",
        name: "Test Site",
        baseUrl: "http://127.0.0.1:3000",
      })
      expect(result.success).toBe(true)
    })
  })

  describe("invalid", () => {
    it("rejects when schemaVersion is missing", () => {
      const result = siteDefinitionSchema.safeParse({
        id: "test",
        name: "Test",
        baseUrl: "http://127.0.0.1:3000",
      })
      expect(result.success).toBe(false)
    })

    it("rejects wrong schemaVersion value", () => {
      const result = siteDefinitionSchema.safeParse({
        schemaVersion: 2,
        id: "test",
        name: "Test",
        baseUrl: "http://127.0.0.1:3000",
      })
      expect(result.success).toBe(false)
    })

    it("rejects empty id", () => {
      const result = siteDefinitionSchema.safeParse({
        schemaVersion: 1,
        id: "",
        name: "Test",
        baseUrl: "http://127.0.0.1:3000",
      })
      expect(result.success).toBe(false)
    })

    it("rejects invalid baseUrl", () => {
      const result = siteDefinitionSchema.safeParse({
        schemaVersion: 1,
        id: "test",
        name: "Test",
        baseUrl: "not-a-url",
      })
      expect(result.success).toBe(false)
    })
  })
})

describe("stepSchema", () => {
  describe("valid", () => {
    it("accepts a goto step with path", () => {
      const result = stepSchema.safeParse({
        action: "goto",
        path: "/test",
      })
      expect(result.success).toBe(true)
    })

    it("accepts an assertVisible step with locator", () => {
      const result = stepSchema.safeParse({
        action: "assertVisible",
        locator: { text: "Hello" },
      })
      expect(result.success).toBe(true)
    })
  })

  describe("invalid", () => {
    it("rejects unknown action", () => {
      const result = stepSchema.safeParse({
        action: "unknown",
      })
      expect(result.success).toBe(false)
    })

    it("rejects goto without path", () => {
      const result = stepSchema.safeParse({
        action: "goto",
      })
      expect(result.success).toBe(false)
    })

    it("rejects goto path that does not start with /", () => {
      const result = stepSchema.safeParse({
        action: "goto",
        path: "no-slash",
      })
      expect(result.success).toBe(false)
    })

    it("rejects assertVisible without locator", () => {
      const result = stepSchema.safeParse({
        action: "assertVisible",
      })
      expect(result.success).toBe(false)
    })

    it("rejects assertVisible with empty locator text", () => {
      const result = stepSchema.safeParse({
        action: "assertVisible",
        locator: { text: "" },
      })
      expect(result.success).toBe(false)
    })
  })
})

describe("scenarioDefinitionSchema", () => {
  describe("valid", () => {
    it("accepts a complete scenario", () => {
      const result = scenarioDefinitionSchema.safeParse({
        schemaVersion: 1,
        id: "smoke",
        name: "Smoke Test",
        siteId: "local",
        steps: [{ action: "goto", path: "/" }],
      })
      expect(result.success).toBe(true)
    })
  })

  describe("invalid", () => {
    it("rejects empty steps array", () => {
      const result = scenarioDefinitionSchema.safeParse({
        schemaVersion: 1,
        id: "smoke",
        name: "Smoke Test",
        siteId: "local",
        steps: [],
      })
      expect(result.success).toBe(false)
    })

    it("rejects when siteId is missing", () => {
      const result = scenarioDefinitionSchema.safeParse({
        schemaVersion: 1,
        id: "smoke",
        name: "Smoke Test",
        steps: [{ action: "goto", path: "/" }],
      })
      expect(result.success).toBe(false)
    })

    it("rejects invalid step in steps", () => {
      const result = scenarioDefinitionSchema.safeParse({
        schemaVersion: 1,
        id: "smoke",
        name: "Smoke Test",
        siteId: "local",
        steps: [{ action: "unknown" }],
      })
      expect(result.success).toBe(false)
    })
  })
})
