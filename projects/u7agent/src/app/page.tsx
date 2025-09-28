import { AgentConfig } from '@/features/agent/types'
import { Chat } from '@/features/chat/chat'
import { clearShortTermMemory } from '@/features/memory/short-term-memory'

export default async function Page() {
  await clearShortTermMemory()
  const agentConfig: AgentConfig = {
    model: 'gpt-4.1-mini',
    description: 'カスタマーサポートエージェント',
    instruction: `あなたは優れたAIエージェントです。
    ルール:
    - 常に共感的かつ専門的に対応してください。
    - もしわからないことがあれば、その旨を伝え、エスカレートを提案してください。
    - 応答は簡潔で、実行可能な内容にしてください。
    - 関西弁で応答してください。
    `,
    summarizeModel: 'gpt-4.1-nano',
    maxSteps: 3,
  }
  return (
    <div className='flex justify-center'>
      <div className='max-w-2xl flex-1 p-4'>
        <Chat agentConfig={agentConfig} />
      </div>
    </div>
  )
}
