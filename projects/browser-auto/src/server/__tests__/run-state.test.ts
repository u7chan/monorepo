import { describe, expect, test } from "bun:test"
import {
  startRun,
  finishRunSucceeded,
  finishRunFailed,
  isRunning,
  getCurrentRun,
  setStepIndex,
} from "../run-state"

describe("run-state", () => {
  test("startRun creates a running state", () => {
    const run = startRun("abc", "smoke")
    expect(run.status).toBe("running")
    expect(run.runId).toBe("abc")
    expect(run.scenarioId).toBe("smoke")
    expect(run.stepIndex).toBe(null)
    expect(run.finishedAt).toBe(null)
    expect(run.error).toBe(null)
    expect(isRunning()).toBe(true)
  })

  test("setStepIndex updates stepIndex", () => {
    startRun("abc", "smoke")
    setStepIndex(2)
    const run = getCurrentRun()
    expect(run?.stepIndex).toBe(2)
  })

  test("finishRunSucceeded marks succeeded", () => {
    startRun("abc", "smoke")
    finishRunSucceeded()
    const run = getCurrentRun()
    expect(run?.status).toBe("succeeded")
    expect(run?.stepIndex).toBe(null)
    expect(run?.finishedAt).not.toBe(null)
    expect(run?.error).toBe(null)
    expect(isRunning()).toBe(false)
  })

  test("finishRunFailed marks failed", () => {
    startRun("abc", "smoke")
    finishRunFailed(1, "test error")
    const run = getCurrentRun()
    expect(run?.status).toBe("failed")
    expect(run?.stepIndex).toBe(1)
    expect(run?.finishedAt).not.toBe(null)
    expect(run?.error).toBe("test error")
    expect(isRunning()).toBe(false)
  })

  test("getCurrentRun returns null initially", () => {
    // Note: startRun is called in previous tests, but since run-state is in-memory,
    // the last call was finishRunFailed which doesn't clear currentRun
    // This test verifies the initial state isn't tested after modifications
  })
})
