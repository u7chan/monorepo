import fs from 'fs/promises'
import path from 'path'
import yaml from 'js-yaml'
import { z } from 'zod'

import { AgentConfig } from '@/features/agent-service/agent-config'

const AGENTS_DIR = path.join(process.cwd(), 'agents')

const agentSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  version: z.string().optional(),
  enabled: z.boolean().optional().default(true),
  model: z.string(),
  description: z.string(),
  instruction: z.string(),
  maxSteps: z.number(),
  tags: z.array(z.string()).optional(),
  owner: z.object({ name: z.string().optional(), contact: z.string().optional() }).optional(),
  tools: z.array(z.object({ name: z.string(), description: z.string().optional() })).optional(),
  notes: z.string().optional(),
})

export type RawAgentSpec = z.infer<typeof agentSchema>

async function listYamlFiles(dir = AGENTS_DIR) {
  try {
    const entries = await fs.readdir(dir)
    return entries.filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
  } catch (err) {
    return []
  }
}

async function readYamlFile(file: string) {
  const full = path.join(AGENTS_DIR, file)
  const raw = await fs.readFile(full, 'utf8')
  const parsed = yaml.load(raw) as unknown
  return { full, parsed }
}

export async function loadAllAgents(): Promise<Array<{ file: string; spec: RawAgentSpec }>> {
  const files = await listYamlFiles()
  const agents = [] as Array<{ file: string; spec: RawAgentSpec }>

  for (const file of files) {
    try {
      const { parsed } = await readYamlFile(file)
      const spec = agentSchema.parse(parsed)
      agents.push({ file, spec })
    } catch (err) {
      // skip invalid files — callers may wish to log or surface
      console.warn('Failed to load agent file', file, err)
    }
  }

  return agents
}

export async function loadAgentById(id: string): Promise<AgentConfig | null> {
  const agents = await loadAllAgents()

  // match by explicit id field first
  const byId = agents.find((a) => a.spec.id === id)
  if (byId) {
    const s = byId.spec
    return buildAgentConfig(s)
  }

  // otherwise match by filename (without ext)
  const byFile = agents.find((a) => path.basename(a.file, path.extname(a.file)) === id)
  if (byFile) {
    return buildAgentConfig(byFile.spec)
  }

  // fallback to first enabled agent
  const enabled = agents.find((a) => a.spec.enabled !== false)
  if (enabled) return buildAgentConfig(enabled.spec)

  return null
}

function buildAgentConfig(s: RawAgentSpec): AgentConfig {
  return {
    model: s.model,
    description: s.description,
    instruction: s.instruction,
    tools: s.tools,
    maxSteps: s.maxSteps,
  }
}

export async function loadDefaultAgent(): Promise<AgentConfig | null> {
  const files = await loadAllAgents()
  const agent = files.find((a) => a.spec.enabled !== false) || files[0]
  return agent ? buildAgentConfig(agent.spec) : null
}

const agentLoader = {
  loadAllAgents,
  loadAgentById,
  loadDefaultAgent,
}

export default agentLoader
