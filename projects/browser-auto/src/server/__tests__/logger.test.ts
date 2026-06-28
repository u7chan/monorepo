import { describe, expect, test } from "bun:test"
import { logger } from "../logger"

describe("logger", () => {
  test("exports a pino logger instance", () => {
    expect(logger).toBeDefined()
    expect(typeof logger.info).toBe("function")
    expect(typeof logger.debug).toBe("function")
    expect(typeof logger.warn).toBe("function")
    expect(typeof logger.error).toBe("function")
    expect(typeof logger.fatal).toBe("function")
  })

  test("default log level is info", () => {
    expect(logger.level).toBe("info")
  })
})
