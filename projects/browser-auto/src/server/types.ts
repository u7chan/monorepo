export type RunStatus = {
  runId: string
  scenarioId: string
  status: "running" | "succeeded" | "failed"
  stepIndex: number | null
  startedAt: string
  finishedAt: string | null
  error: string | null
}
