export interface AgentConfig {
  model: string
  description: string
  instruction: string
  summarizeModel?: string
  maxSteps: number
}
