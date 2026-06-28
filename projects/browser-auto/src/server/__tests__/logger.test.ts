import { describe, expect, it } from "bun:test"
import { logger } from "../logger"

describe("logger", () => {
  it("exports a pino logger instance", () => {
    expect(logger).toBeDefined()
    expect(typeof logger.info).toBe("function")
    expect(typeof logger.debug).toBe("function")
    expect(typeof logger.warn).toBe("function")
    expect(typeof logger.error).toBe("function")
    expect(typeof logger.fatal).toBe("function")
  })

  it("has info as default log level", () => {
    expect(logger.level).toBe("info")
  })
})
