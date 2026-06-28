import type { RunStatus } from "./types"

let currentRun: RunStatus | null = null

export function getCurrentRun(): RunStatus | null {
  return currentRun
}

export function isRunning(): boolean {
  return currentRun?.status === "running"
}

export function startRun(runId: string, scenarioId: string): RunStatus {
  const run: RunStatus = {
    runId,
    scenarioId,
    status: "running",
    stepIndex: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
  }
  currentRun = run
  return run
}

export function setStepIndex(stepIndex: number): void {
  if (currentRun) {
    currentRun.stepIndex = stepIndex
  }
}

export function finishRunSucceeded(): void {
  if (currentRun) {
    currentRun.status = "succeeded"
    currentRun.stepIndex = null
    currentRun.finishedAt = new Date().toISOString()
    currentRun.error = null
  }
}

export function finishRunFailed(stepIndex: number, error: string): void {
  if (currentRun) {
    currentRun.status = "failed"
    currentRun.stepIndex = stepIndex
    currentRun.finishedAt = new Date().toISOString()
    currentRun.error = error
  }
}
