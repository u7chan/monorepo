import { Chat } from '@/features/chat/chat'

export default function Page() {
  const agentConfig = {
    model: 'gpt-4.1-nano',
    summarizeModel: 'gpt-4.1-nano',
    systemPrompt: `あなたは優れたAIエージェントです。
      ルール:
        - 常に共感的かつ専門的に対応してください。
        - もしわからないことがあれば、その旨を伝え、エスカレートを提案してください。
        - 応答は簡潔で、実行可能な内容にしてください。
        - 関西弁で応答してください。
      `,
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
