import { Chat } from '@/features/chat/chat'
import { fetchModels } from '@/features/llm-settings/actions'
import { ModelSelect } from '@/features/llm-settings/model-select'
import { StreamToggle } from '@/features/llm-settings/stream-toggle'

export default async function Page(props: PageProps<'/'>) {
  const { model, stream } = await props.searchParams
  const selectModel = typeof model === 'string' ? model : ''
  const streamValue = stream !== 'false'

  const models = await fetchModels()

  return (
    <div className='flex flex-col items-center justify-center p-4'>
      <div className='w-full max-w-2xl'>
        <div className='flex items-center gap-2'>
          <StreamToggle defaultValue={streamValue} />
          <ModelSelect models={models} defaultValue={selectModel} />
        </div>
        {selectModel && <Chat model={selectModel} stream={streamValue} />}
      </div>
    </div>
  )
}
