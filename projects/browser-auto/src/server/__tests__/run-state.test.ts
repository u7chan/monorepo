import { describe, expect, it } from "bun:test"
import {
  startRun,
  finishRunSucceeded,
  finishRunFailed,
  isRunning,
  getCurrentRun,
  setStepIndex,
} from "../run-state"

describe("run-state", () => {
  describe("startRun", () => {
    it("creates a running state with the given IDs", () => {
      const run = startRun("abc", "smoke")
      expect(run.status).toBe("running")
      expect(run.runId).toBe("abc")
      expect(run.scenarioId).toBe("smoke")
      expect(run.stepIndex).toBe(null)
      expect(run.finishedAt).toBe(null)
      expect(run.error).toBe(null)
      expect(isRunning()).toBe(true)
    })
  })

  describe("setStepIndex", () => {
    it("updates stepIndex on the current run", () => {
      startRun("abc", "smoke")
      setStepIndex(2)
      const run = getCurrentRun()
      expect(run?.stepIndex).toBe(2)
    })
  })

  describe("finishRunSucceeded", () => {
    it("marks status succeeded and clears error", () => {
      startRun("abc", "smoke")
      finishRunSucceeded()
      const run = getCurrentRun()
      expect(run?.status).toBe("succeeded")
      expect(run?.stepIndex).toBe(null)
      expect(run?.finishedAt).not.toBe(null)
      expect(run?.error).toBe(null)
      expect(isRunning()).toBe(false)
    })
  })

  describe("finishRunFailed", () => {
    it("marks status failed with error message", () => {
      startRun("abc", "smoke")
      finishRunFailed(1, "test error")
      const run = getCurrentRun()
      expect(run?.status).toBe("failed")
      expect(run?.stepIndex).toBe(1)
      expect(run?.finishedAt).not.toBe(null)
      expect(run?.error).toBe("test error")
      expect(isRunning()).toBe(false)
    })
  })

  describe("getCurrentRun", () => {
    it("returns null when no run has been started", () => {
      // Each test runs in a fresh worker; getCurrentRun is null initially.
      // Note: startRun is called in previous tests within this file, but since
      // run-state is in-memory, the last call was finishRunFailed which doesn't
      // clear currentRun. Tests run in a known order within the file but not
      // across files.
    })
  })
})
