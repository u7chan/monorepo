import { loadAgentById } from '@/features/agent/loadAgents'
import { AgentConfig } from '@/features/agent/types'
import { Chat } from '@/features/chat/chat'
import { clearShortTermMemory } from '@/features/memory/short-term-memory'

export default async function Page() {
  await clearShortTermMemory()
  const agentConfig = (await loadAgentById('001')) as AgentConfig | null

  if (!agentConfig) {
    throw new Error('No agent configuration found — make sure agents/*.yaml contains at least one enabled agent')
  }
  return (
    <div className='flex h-dvh justify-center overflow-hidden p-4'>
      <div className='flex min-h-0 w-full max-w-2xl flex-1 flex-col gap-3'>
        <div className='flex min-h-0 flex-1 flex-col'>
          <Chat agentConfig={agentConfig} />
        </div>
      </div>
    </div>
  )
}
