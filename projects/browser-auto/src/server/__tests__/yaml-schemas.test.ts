import { describe, expect, test } from "bun:test"
import { siteDefinitionSchema, scenarioDefinitionSchema, stepSchema } from "../yaml-schemas"

describe("siteDefinitionSchema", () => {
  test("valid site", () => {
    const result = siteDefinitionSchema.safeParse({
      schemaVersion: 1,
      id: "test",
      name: "Test Site",
      baseUrl: "http://127.0.0.1:3000",
    })
    expect(result.success).toBe(true)
  })

  test("missing schemaVersion", () => {
    const result = siteDefinitionSchema.safeParse({
      id: "test",
      name: "Test",
      baseUrl: "http://127.0.0.1:3000",
    })
    expect(result.success).toBe(false)
  })

  test("wrong schemaVersion", () => {
    const result = siteDefinitionSchema.safeParse({
      schemaVersion: 2,
      id: "test",
      name: "Test",
      baseUrl: "http://127.0.0.1:3000",
    })
    expect(result.success).toBe(false)
  })

  test("empty id", () => {
    const result = siteDefinitionSchema.safeParse({
      schemaVersion: 1,
      id: "",
      name: "Test",
      baseUrl: "http://127.0.0.1:3000",
    })
    expect(result.success).toBe(false)
  })

  test("invalid baseUrl", () => {
    const result = siteDefinitionSchema.safeParse({
      schemaVersion: 1,
      id: "test",
      name: "Test",
      baseUrl: "not-a-url",
    })
    expect(result.success).toBe(false)
  })
})

describe("stepSchema", () => {
  test("valid goto step", () => {
    const result = stepSchema.safeParse({
      action: "goto",
      path: "/test",
    })
    expect(result.success).toBe(true)
  })

  test("valid assertVisible step", () => {
    const result = stepSchema.safeParse({
      action: "assertVisible",
      locator: { text: "Hello" },
    })
    expect(result.success).toBe(true)
  })

  test("unknown action", () => {
    const result = stepSchema.safeParse({
      action: "unknown",
    })
    expect(result.success).toBe(false)
  })

  test("goto without path", () => {
    const result = stepSchema.safeParse({
      action: "goto",
    })
    expect(result.success).toBe(false)
  })

  test("goto with path not starting with /", () => {
    const result = stepSchema.safeParse({
      action: "goto",
      path: "no-slash",
    })
    expect(result.success).toBe(false)
  })

  test("assertVisible without locator", () => {
    const result = stepSchema.safeParse({
      action: "assertVisible",
    })
    expect(result.success).toBe(false)
  })

  test("assertVisible with empty text", () => {
    const result = stepSchema.safeParse({
      action: "assertVisible",
      locator: { text: "" },
    })
    expect(result.success).toBe(false)
  })
})

describe("scenarioDefinitionSchema", () => {
  test("valid scenario", () => {
    const result = scenarioDefinitionSchema.safeParse({
      schemaVersion: 1,
      id: "smoke",
      name: "Smoke Test",
      siteId: "local",
      steps: [{ action: "goto", path: "/" }],
    })
    expect(result.success).toBe(true)
  })

  test("empty steps", () => {
    const result = scenarioDefinitionSchema.safeParse({
      schemaVersion: 1,
      id: "smoke",
      name: "Smoke Test",
      siteId: "local",
      steps: [],
    })
    expect(result.success).toBe(false)
  })

  test("missing siteId", () => {
    const result = scenarioDefinitionSchema.safeParse({
      schemaVersion: 1,
      id: "smoke",
      name: "Smoke Test",
      steps: [{ action: "goto", path: "/" }],
    })
    expect(result.success).toBe(false)
  })

  test("invalid step in steps", () => {
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
