import { AgentConfig } from '@/features/agent/types'
import { loadAgentById } from '@/features/agent/loadAgents'
import { Chat } from '@/features/chat/chat'
import { clearShortTermMemory } from '@/features/memory/short-term-memory'

export default async function Page() {
  await clearShortTermMemory()
  const agentConfig = (await loadAgentById('001')) as AgentConfig | null

  if (!agentConfig) {
    throw new Error('No agent configuration found — make sure agents/*.yaml contains at least one enabled agent')
  }
  return (
    <div className='flex justify-center'>
      <div className='max-w-2xl flex-1 p-4'>
        <Chat agentConfig={agentConfig} />
      </div>
    </div>
  )
}
