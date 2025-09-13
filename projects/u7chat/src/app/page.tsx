import { Chat } from '@/features/chat/chat'
import { fetchModels } from '@/features/llm-models/llm-model-actions'
import { ModelSelect } from '@/features/llm-models/model-select'

export default async function Page(props: PageProps<'/'>) {
  const { model } = await props.searchParams
  const models = await fetchModels()
  return (
    <div className='flex min-h-screen flex-col items-center justify-center p-4'>
      <div className='w-full max-w-lg rounded border border-gray-200 p-4'>
        <ModelSelect models={models} defaultModel={typeof model === 'string' ? model : ''} />
        <Chat />
      </div>
    </div>
  )
}
