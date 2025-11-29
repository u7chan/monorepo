export interface AgentConfig {
  model: string
  description: string
  instruction: string
  summarizeModel?: string
  tools?: Array<{ name: string; description?: string }>
  maxSteps: number
}
